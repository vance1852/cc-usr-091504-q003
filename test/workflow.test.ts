import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DomainError } from '../src/errors.js';
import { baseInstruction, reachCustody, setupFixture, tempDbPath } from './helpers.js';
import { openDatabase } from '../src/db.js';
import { MedicationService } from '../src/services/medicationService.js';

describe('跨班交接', () => {
  it('数量与账面一致才允许交接，保管人随交接链更新', () => {
    const f = setupFixture();
    reachCustody(f);
    f.service.execute(f.staffA.id, f.medicationId, { scheduledTime: '16:30', administeredQty: 5 });

    const h = f.service.handoff(f.staffA.id, f.medicationId, { toStaffId: f.staffB.id, quantity: 15 });
    assert.equal(h.fromStaffId, f.staffA.id);
    assert.equal(h.toStaffId, f.staffB.id);
    assert.equal(h.quantity, 15);

    const med = f.db.prepare(`SELECT current_holder_id FROM medications WHERE id = ?`).get(f.medicationId) as any;
    assert.equal(med.current_holder_id, f.staffB.id);

    // 交接后原保管人不再能执行，新保管人可以
    assert.throws(
      () => f.service.execute(f.staffA.id, f.medicationId, { scheduledTime: '16:30', administeredQty: 5, scheduledDate: '2026-09-21' }),
      (e: Error) => e instanceof DomainError && e.code === 'not_holder',
    );
    const exe2 = f.service.execute(f.staffB.id, f.medicationId, { scheduledTime: '16:30', administeredQty: 5, scheduledDate: '2026-09-21' });
    assert.equal(exe2.quantityAfter, 10);
  });

  it('交接数量不一致时中止且保管人不变', () => {
    const f = setupFixture();
    reachCustody(f);
    assert.throws(
      () => f.service.handoff(f.staffA.id, f.medicationId, { toStaffId: f.staffB.id, quantity: 99 }),
      (e: Error) => e instanceof DomainError && e.code === 'quantity_mismatch',
    );
    const med = f.db.prepare(`SELECT current_holder_id FROM medications WHERE id = ?`).get(f.medicationId) as any;
    assert.equal(med.current_holder_id, f.staffA.id);
  });

  it('非保管人不能发起交接', () => {
    const f = setupFixture();
    reachCustody(f);
    assert.throws(
      () => f.service.handoff(f.staffB.id, f.medicationId, { toStaffId: f.staffA.id, quantity: 20 }),
      (e: Error) => e instanceof DomainError && e.code === 'not_holder',
    );
  });

  it('完整交接链：receive → handoff → handoff → return，数量连续', () => {
    const f = setupFixture();
    reachCustody(f);
    f.service.handoff(f.staffA.id, f.medicationId, { toStaffId: f.staffB.id, quantity: 20 }, { key: 'h1' });
    f.service.handoff(f.staffB.id, f.medicationId, { toStaffId: f.staffA.id, quantity: 20 }, { key: 'h2' });
    f.service.returnMedication(f.staffA.id, f.medicationId, { note: '周五带回' }, { key: 'r1' });

    const chain = f.db.prepare(`SELECT type, quantity_at_event FROM custody_events WHERE medication_id = ? ORDER BY rowid`).all(f.medicationId) as any[];
    assert.deepEqual(chain.map((c) => c.type), ['receive', 'handoff', 'handoff', 'return']);
    assert.ok(chain.every((c) => c.quantity_at_event === 20));
  });

  it('重复退回被拒绝（唯一索引 + 状态双保险）', () => {
    const f = setupFixture();
    reachCustody(f);
    f.service.returnMedication(f.staffA.id, f.medicationId, {}, { key: 'r1' });
    assert.throws(
      () => f.service.returnMedication(f.staffA.id, f.medicationId, {}, { key: 'r2' }),
      (e: Error) => e instanceof DomainError && e.code === 'already_returned',
    );
  });
});

describe('扫码幂等', () => {
  it('相同幂等键重复执行只产生一条记录并回放首次结果', () => {
    const f = setupFixture();
    reachCustody(f);
    const r1 = f.service.execute(
      f.staffA.id, f.medicationId,
      { scheduledTime: '16:30', administeredQty: 5, scheduledDate: '2026-09-21' },
      { key: 'scan-abc', deviceId: 'scanner-1' },
    );
    const replay = (): never => {
      throw (() => {
        try {
          f.service.execute(
            f.staffA.id, f.medicationId,
            { scheduledTime: '16:30', administeredQty: 5, scheduledDate: '2026-09-21' },
            { key: 'scan-abc', deviceId: 'scanner-1' },
          );
          throw new Error('应当回放而不是再次执行');
        } catch (e) {
          return e;
        }
      })();
    };
    let replayPayload: any;
    try {
      replay();
    } catch (e: any) {
      replayPayload = e;
    }
    assert.equal(replayPayload.name, 'IdempotentReplay');
    assert.equal(replayPayload.payload.executionId, r1.executionId);

    const count = (f.db.prepare(`SELECT COUNT(*) c FROM executions WHERE medication_id = ?`).get(f.medicationId) as any).c;
    assert.equal(count, 1);
    const med = f.db.prepare(`SELECT current_quantity FROM medications WHERE id = ?`).get(f.medicationId) as any;
    assert.equal(med.current_quantity, 15); // 没有被扣两次
    const stored = f.db.prepare(`SELECT replayed FROM action_idempotency WHERE idem_key = ?`).get('scan-abc') as any;
    assert.equal(stored.replayed, 1);
  });

  it('接收动作重复扫码幂等（不同键但状态已变也不允许第二次接收）', () => {
    const f = setupFixture();
    f.service.receive(f.staffA.id, f.medicationId, { packageIntact: true, storageMet: true }, { key: 'recv-1' });
    assert.throws(
      () => f.service.receive(f.staffA.id, f.medicationId, { packageIntact: true, storageMet: true }, { key: 'recv-2' }),
      (e: Error) => e instanceof DomainError && e.code === 'not_receivable',
    );
    const count = (f.db.prepare(`SELECT COUNT(*) c FROM custody_events WHERE medication_id = ? AND type='receive'`).get(f.medicationId) as any).c;
    assert.equal(count, 1);
  });
});

describe('指示变更', () => {
  it('家长提交新版本 → 旧版 superseded、立即冻结，重新双人核对后恢复', () => {
    const f = setupFixture();
    reachCustody(f);
    f.service.execute(f.staffA.id, f.medicationId, { scheduledTime: '16:30', administeredQty: 5 });

    const change = f.service.submitInstructionChange(f.guardianId, f.medicationId, {
      ...baseInstruction,
      doseText: '7.5ml',
      scheduledTimes: ['16:30', '18:00'],
    });
    assert.equal(change.version, 2);
    assert.equal(change.freezeReason, 'instruction_change_pending');

    let med = f.db.prepare(`SELECT status FROM medications WHERE id = ?`).get(f.medicationId) as any;
    assert.equal(med.status, 'frozen');
    assert.throws(
      () => f.service.execute(f.staffA.id, f.medicationId, { scheduledTime: '16:30', administeredQty: 5 }),
      (e: Error) => e instanceof DomainError && e.code === 'medication_frozen',
    );

    // 标签是 5ml，与新指示 7.5ml 冲突 → 保持冻结（校方不擅自判断）
    let v = f.service.verify(f.staffA.id, f.medicationId, { staff1Id: f.staffA.id, staff2Id: f.staffB.id, storageMet: true });
    assert.equal(v.result, 'conflict');

    // 家长送来与新指示一致的新包装：以标签 7.5ml 重新登记场景外，这里直接更新标签模拟换新盒
    f.db.exec(`UPDATE medications SET label_dose_text='7.5ml' WHERE id='${f.medicationId}'`);
    v = f.service.verify(f.staffA.id, f.medicationId, { staff1Id: f.staffA.id, staff2Id: f.staffB.id, storageMet: true });
    assert.equal(v.result, 'verified');
    med = f.db.prepare(`SELECT status, freeze_reason FROM medications WHERE id = ?`).get(f.medicationId) as any;
    assert.equal(med.status, 'in_custody');
    assert.equal(med.freeze_reason, null);

    // v2 生效，旧计划时点仍在；新时点 18:00 可执行
    const r = f.service.execute(f.staffA.id, f.medicationId, { scheduledTime: '18:00', administeredQty: 7.5 });
    assert.equal(r.authVersion, 2);
  });

  it('历史版本永不删除，审计可追溯每次核对', () => {
    const f = setupFixture();
    reachCustody(f);
    f.service.submitInstructionChange(f.guardianId, f.medicationId, baseInstruction);
    const versions = f.db.prepare(`SELECT version, status FROM authorizations WHERE medication_id = ? ORDER BY version`).all(f.medicationId) as any[];
    assert.equal(versions.length, 2);
    assert.equal(versions[0].status, 'superseded');
    assert.equal(versions[1].status, 'pending');
  });
});

describe('授权到期巡检', () => {
  it('授权过期后巡检冻结并通知，过期期间不能执行', () => {
    const f = setupFixture(); // 授权有效期至 2026-09-30，正常完成接收核对
    reachCustody(f);
    // 模拟时间流逝：当前 active 授权有效期回溯到昨天
    f.db.exec(`UPDATE authorizations SET valid_until = '2026-09-19' WHERE medication_id = '${f.medicationId}' AND status = 'active'`);

    const r = f.service.sweepExpirations();
    assert.ok(r.frozen.includes(f.medicationId));
    const med = f.db.prepare(`SELECT status, freeze_reason FROM medications WHERE id = ?`).get(f.medicationId) as any;
    assert.equal(med.freeze_reason, 'auth_expired');
    const notifs = f.service.listNotifications('responsible') as any[];
    assert.ok(notifs.some((n) => n.type === 'auth_expired'));
  });
});

describe('离线补传', () => {
  it('批量补传历史执行与异常，标记 backfilled，重复补传安全', () => {
    const f = setupFixture();
    reachCustody(f);
    const events = [
      { kind: 'execution', clientEventId: 'e1', deviceId: 'pad-7', occurredAt: '2026-09-18T08:30:00.000Z', scheduledTime: '16:30', administeredQty: 5 },
      { kind: 'incident', clientEventId: 'i1', deviceId: 'pad-7', occurredAt: '2026-09-18T09:00:00.000Z', type: 'student_refused', detail: '孩子睡过头' },
      { kind: 'execution', clientEventId: 'e2', deviceId: 'pad-7', occurredAt: '2026-09-19T08:30:00.000Z', scheduledTime: '16:30', administeredQty: 5 },
    ];
    const r = f.service.backfill(f.staffA.id, f.medicationId, events);
    assert.equal(r.processed, 3);

    const execs = f.db.prepare(`SELECT backfilled, scheduled_date, occurred_at FROM executions WHERE medication_id = ? ORDER BY occurred_at`).all(f.medicationId) as any[];
    assert.equal(execs.length, 2);
    assert.ok(execs.every((e) => e.backfilled === 1));
    assert.equal(execs[0].scheduled_date, '2026-09-18');

    // 设备重连后重复补传同一批：全部回放，不产生重复扣减
    const again = f.service.backfill(f.staffA.id, f.medicationId, events);
    assert.equal(again.processed, 3);
    const med = f.db.prepare(`SELECT current_quantity FROM medications WHERE id = ?`).get(f.medicationId) as any;
    assert.equal(med.current_quantity, 10); // 20 - 5 - 5
  });

  it('补传未来时间被拒绝', () => {
    const f = setupFixture();
    reachCustody(f);
    assert.throws(
      () =>
        f.service.backfill(f.staffA.id, f.medicationId, [
          { kind: 'execution', clientEventId: 'x', occurredAt: '2099-01-01T00:00:00Z', scheduledTime: '16:30', administeredQty: 5 },
        ]),
      (e: Error) => e instanceof DomainError,
    );
  });
});

describe('并发领取（跨连接）', () => {
  it('两个数据库连接依次领取同一时点，唯一索引只允许一次成功', () => {
    const path = tempDbPath();
    const seed = new MedicationService(openDatabase(path));
    const g = seed.createGuardian({ name: '家长', phone: '1', emergencyPhone: '2' });
    const stu = seed.createStudent(g.id, '学生');
    const a = seed.createStaff({ name: 'A', role: 'teacher' });
    const b = seed.createStaff({ name: 'B', role: 'teacher' });
    const med = seed.registerMedication({
      guardianId: g.id, studentId: stu.id, packageCode: 'P', labelDrugName: '阿莫西林', labelDoseText: '5ml',
      expiryDate: '2027-01-01', storageRequirement: 'room_temp', initialQuantity: 20, quantityUnit: 'ml',
      instruction: baseInstruction,
    });
    seed.receive(a.id, med.medicationId, { packageIntact: true, storageMet: true });
    seed.verify(a.id, med.medicationId, { staff1Id: a.id, staff2Id: b.id, storageMet: true });

    const connA = new MedicationService(openDatabase(path));
    const connB = new MedicationService(openDatabase(path));
    connA.execute(a.id, med.medicationId, { scheduledTime: '16:30', administeredQty: 5, scheduledDate: '2026-09-22' }, { key: 'A-key' });
    assert.throws(
      () => connB.execute(a.id, med.medicationId, { scheduledTime: '16:30', administeredQty: 5, scheduledDate: '2026-09-22' }, { key: 'B-key' }),
      (e: Error) => e instanceof DomainError && e.code === 'slot_already_executed',
    );

    const check = openDatabase(path);
    assert.equal((check.prepare(`SELECT COUNT(*) c FROM executions`).get() as any).c, 1);
    assert.equal((check.prepare(`SELECT current_quantity q FROM medications WHERE id = ?`).get(med.medicationId) as any).q, 15);
  });
});
