import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DomainError } from '../src/errors.js';
import { reachCustody, setupFixture } from './helpers.js';

describe('登记与接收', () => {
  it('家长只能为本人孩子登记药品', () => {
    const f = setupFixture();
    const other = f.service.createGuardian({ name: '别家', phone: '1', emergencyPhone: '2' });
    assert.throws(
      () =>
        f.service.registerMedication({
          guardianId: other.id,
          studentId: f.studentId,
          packageCode: 'X',
          labelDrugName: '药',
          labelDoseText: '1片',
          expiryDate: '2027-01-01',
          storageRequirement: 'room_temp',
          initialQuantity: 10,
          quantityUnit: '片',
          instruction: {
            drugName: '药', form: 'tablet', doseText: '1片', route: 'oral',
            scheduledTimes: ['16:30'], validFrom: '2026-09-01', validUntil: '2026-09-30',
          },
        }),
      (e: Error) => e instanceof DomainError && e.statusCode === 403,
    );
  });

  it('登记时声明包装破损直接冻结并通知双方', () => {
    const f = setupFixture();
    const { db, service } = f;
    const guardian = service.createGuardian({ name: '张', phone: '1', emergencyPhone: '2' });
    const student = service.createStudent(guardian.id, '张小');
    const med = service.registerMedication({
      guardianId: guardian.id, studentId: student.id, packageCode: 'P2',
      labelDrugName: '药', labelDoseText: '1片', expiryDate: '2027-01-01',
      storageRequirement: 'room_temp', initialQuantity: 10, quantityUnit: '片',
      packageDamaged: true,
      instruction: {
        drugName: '药', form: 'tablet', doseText: '1片', route: 'oral',
        scheduledTimes: ['16:30'], validFrom: '2026-09-01', validUntil: '2026-09-30',
      },
    });
    assert.equal(med.status, 'frozen');
    assert.equal(med.freezeReason, 'package_damaged');
    const n = db.prepare(`SELECT audience, type FROM notifications WHERE medication_id = ?`).all(med.medicationId);
    assert.ok(n.some((x: any) => x.audience === 'both'));
  });

  it('已过有效期的药品不能接收', () => {
    const f = setupFixture({ expiryDate: '2020-01-01' });
    assert.throws(
      () => f.service.receive(f.staffA.id, f.medicationId, { packageIntact: true, storageMet: true }),
      (e: Error) => e instanceof DomainError && e.code === 'medication_expired',
    );
  });

  it('接收时发现保管条件失效 → 冻结并通知', () => {
    const f = setupFixture();
    const r = f.service.receive(f.staffA.id, f.medicationId, { packageIntact: true, storageMet: false });
    assert.equal(r.status, 'frozen');
    assert.equal(r.freezeReason, 'storage_breach');
    const notifs = f.service.listNotifications('responsible') as any[];
    assert.ok(notifs.some((n) => n.type === 'freeze'));
  });
});

describe('双人核对与信息冲突', () => {
  it('药盒标签剂量与书面指示不一致 → conflict，冻结执行，不提供剂量判断', () => {
    const f = setupFixture({ labelDoseText: '10ml' }); // 指示 5ml，标签 10ml
    f.service.receive(f.staffA.id, f.medicationId, { packageIntact: true, storageMet: true });
    const v = f.service.verify(f.staffA.id, f.medicationId, {
      staff1Id: f.staffA.id, staff2Id: f.staffB.id, storageMet: true,
    });
    assert.equal(v.result, 'conflict');
    assert.equal(v.labelMatch, false);
    assert.match(v.conflicts.join('；'), /剂量不一致/);

    const med = f.db.prepare(`SELECT status, freeze_reason FROM medications WHERE id = ?`).get(f.medicationId) as any;
    assert.equal(med.status, 'frozen');
    assert.equal(med.freeze_reason, 'info_conflict');

    // 冻结状态执行被拒
    assert.throws(
      () => f.service.execute(f.staffA.id, f.medicationId, { scheduledTime: '16:30', administeredQty: 5 }),
      (e: Error) => e instanceof DomainError && e.code === 'medication_frozen',
    );
  });

  it('核对必须两名不同人员', () => {
    const f = setupFixture();
    f.service.receive(f.staffA.id, f.medicationId, { packageIntact: true, storageMet: true });
    assert.throws(
      () => f.service.verify(f.staffA.id, f.medicationId, { staff1Id: f.staffA.id, staff2Id: f.staffA.id, storageMet: true }),
      (e: Error) => e instanceof DomainError && e.statusCode === 400,
    );
  });

  it('同一授权版本重复核对只保留首次结论（重复扫码无第二次动作）', () => {
    const f = setupFixture();
    reachCustody(f);
    const again = f.service.verify(f.staffA.id, f.medicationId, {
      staff1Id: f.staffA.id, staff2Id: f.staffB.id, storageMet: true,
    });
    assert.equal(again.duplicated, true);
    assert.equal(again.result, 'verified');
    const count = (f.db.prepare(`SELECT COUNT(*) c FROM verifications WHERE medication_id = ?`).get(f.medicationId) as any).c;
    assert.equal(count, 1);
  });
});

describe('执行与差错事件', () => {
  it('正常执行扣减数量并写入不可变执行记录', () => {
    const f = setupFixture();
    reachCustody(f);
    const r = f.service.execute(f.staffA.id, f.medicationId, { scheduledTime: '16:30', administeredQty: 5 });
    assert.equal(r.quantityBefore, 20);
    assert.equal(r.quantityAfter, 15);

    const med = f.db.prepare(`SELECT current_quantity, status FROM medications WHERE id = ?`).get(f.medicationId) as any;
    assert.equal(med.current_quantity, 15);
    assert.equal(med.status, 'in_custody');

    // 没有任何修改/删除执行记录的服务方法；直接尝试更新应被业务禁止（追加式模型）
    assert.throws(() => {
      f.db.exec(`DELETE FROM executions WHERE id = '${r.executionId}'`);
    });
  });

  it('最后一次执行耗尽后状态为 depleted', () => {
    const f = setupFixture();
    reachCustody(f);
    const r = f.service.execute(f.staffA.id, f.medicationId, { scheduledTime: '16:30', administeredQty: 20 });
    assert.equal(r.quantityAfter, 0);
    assert.equal(r.depleted, true);
  });

  it('漏执行/学生拒绝通过差错事件追加，不改动已有执行记录', () => {
    const f = setupFixture();
    reachCustody(f);
    const exe = f.service.execute(f.staffA.id, f.medicationId, { scheduledTime: '16:30', administeredQty: 5 });

    f.service.reportIncident(f.staffA.id, f.medicationId, {
      type: 'missed_dose', detail: '值班换班错过 16:30', scheduledDate: '2026-09-21', scheduledTime: '16:30',
    });
    f.service.reportIncident(f.staffB.id, f.medicationId, { type: 'student_refused', detail: '学生说不舒服拒绝' });

    const row = f.db.prepare(`SELECT administered_qty FROM executions WHERE id = ?`).get(exe.executionId) as any;
    assert.equal(row.administered_qty, 5); // 原执行记录不受影响
    const incs = f.db.prepare(`SELECT type FROM incidents WHERE medication_id = ? ORDER BY rowid`).all(f.medicationId) as any[];
    assert.deepEqual(incs.map((i) => i.type), ['missed_dose', 'student_refused']);
  });

  it('运行中上报包装破损/保管失效立即冻结', () => {
    const f = setupFixture();
    reachCustody(f);
    const r = f.service.reportIncident(f.staffA.id, f.medicationId, { type: 'package_damaged', detail: '瓶身裂纹' });
    assert.equal(r.freezes, true);
    const med = f.db.prepare(`SELECT status, freeze_reason, package_state FROM medications WHERE id = ?`).get(f.medicationId) as any;
    assert.equal(med.status, 'frozen');
    assert.equal(med.freeze_reason, 'package_damaged');
    assert.equal(med.package_state, 'damaged');
  });

  it('非当前保管人不能执行', () => {
    const f = setupFixture();
    reachCustody(f);
    assert.throws(
      () => f.service.execute(f.staffB.id, f.medicationId, { scheduledTime: '16:30', administeredQty: 5 }),
      (e: Error) => e instanceof DomainError && e.code === 'not_holder',
    );
  });
});
