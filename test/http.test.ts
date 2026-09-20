import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp, type AppContext } from '../src/app.js';
import type { WrittenInstruction } from '../src/domain/types.js';

const instruction: WrittenInstruction = {
  drugName: '布洛芬', form: 'liquid', doseText: '5ml', route: 'oral',
  scheduledTimes: ['16:30'], validFrom: '2026-09-01', validUntil: '2026-09-30',
};

describe('HTTP API 端到端', () => {
  let ctx: AppContext;
  let guardianToken: string;
  let guardianId: string;
  let studentId: string;
  let tokenA: string;
  let idA: string;
  let tokenB: string;
  let idB: string;
  let respToken: string;
  let medId: string;

  before(async () => {
    ctx = await buildApp(':memory:', false);
  });

  async function call(method: 'GET' | 'POST', url: string, opts: { token?: string; body?: unknown; idem?: string } = {}) {
    const res = await ctx.app.inject({
      method,
      url,
      payload: opts.body,
      headers: {
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.idem ? { 'x-idempotency-key': opts.idem } : {}),
      },
    } as never);
    return { status: res.statusCode, json: res.json() as any };
  }

  it('准备基础数据', async () => {
    const g = await call('POST', '/admin/guardians', { body: { name: '林家长', phone: '13800000000', emergencyPhone: '13700000000' } });
    assert.equal(g.status, 200);
    guardianToken = g.json.token;
    guardianId = g.json.id;

    const s = await call('POST', '/admin/students', { body: { guardianId, name: '林小果' } });
    studentId = s.json.id;

    const a = await call('POST', '/admin/staff', { body: { name: '周老师', role: 'teacher' } });
    tokenA = a.json.token; idA = a.json.id;
    const b = await call('POST', '/admin/staff', { body: { name: '吴老师', role: 'nurse' } });
    tokenB = b.json.token; idB = b.json.id;
    const r = await call('POST', '/admin/staff', { body: { name: '孙主任', role: 'coordinator', responsible: true } });
    respToken = r.json.token;
  });

  it('无 token 拒绝访问', async () => {
    const r = await call('GET', '/guardian/view');
    assert.equal(r.status, 401);
  });

  it('家长不能调用校方接口，反之亦然', async () => {
    const r1 = await call('POST', `/staff/medications/x/receive`, { token: guardianToken, body: {} });
    assert.equal(r1.status, 403);
    const r2 = await call('GET', '/guardian/view', { token: tokenA });
    assert.equal(r2.status, 403);
  });

  it('家长登记 → 校方接收 → 双人核对 → 执行', async () => {
    const reg = await call('POST', '/guardian/medications', {
      token: guardianToken,
      body: {
        studentId, packageCode: 'BOX-9', labelDrugName: '布洛芬', labelDoseText: '5ml',
        expiryDate: '2027-06-01', storageRequirement: 'cool_dark', initialQuantity: 30, quantityUnit: 'ml',
        instruction,
      },
    });
    assert.equal(reg.status, 200);
    medId = reg.json.medicationId;

    const recv = await call('POST', `/staff/medications/${medId}/receive`, {
      token: tokenA, idem: 'scan-receive-1', body: { packageIntact: true, storageMet: true },
    });
    assert.equal(recv.status, 200);
    assert.equal(recv.json.status, 'in_custody');

    // 接收重复扫码（同键）→ 200 回放
    const recv2 = await call('POST', `/staff/medications/${medId}/receive`, {
      token: tokenA, idem: 'scan-receive-1', body: { packageIntact: true, storageMet: true },
    });
    assert.equal(recv2.status, 200);
    assert.equal(recv2.json.replayed, true);

    const v = await call('POST', `/staff/medications/${medId}/verify`, {
      token: tokenA, body: { staff1Id: idA, staff2Id: idB, storageMet: true },
    });
    assert.equal(v.json.result, 'verified');

    const exe = await call('POST', `/staff/medications/${medId}/execute`, {
      token: tokenA, idem: 'scan-exe-1', body: { scheduledTime: '16:30', administeredQty: 5 },
    });
    assert.equal(exe.status, 200);
    assert.equal(exe.json.quantityAfter, 25);
  });

  it('同一时点并发/重复执行：第二次（不同幂等键）被 409 拒绝', async () => {
    const dup = await call('POST', `/staff/medications/${medId}/execute`, {
      token: tokenA, idem: 'scan-exe-2', body: { scheduledTime: '16:30', administeredQty: 5 },
    });
    assert.equal(dup.status, 409);
    assert.equal(dup.json.error, 'slot_already_executed');

    // 同键重试 → 200 回放，数量不变
    const replay = await call('POST', `/staff/medications/${medId}/execute`, {
      token: tokenA, idem: 'scan-exe-1', body: { scheduledTime: '16:30', administeredQty: 5 },
    });
    assert.equal(replay.status, 200);
    assert.equal(replay.json.replayed, true);
    assert.equal(replay.json.result.quantityAfter, 25);
  });

  it('交接后保管人变更；数量不符时 409', async () => {
    const bad = await call('POST', `/staff/medications/${medId}/handoff`, {
      token: tokenA, body: { toStaffId: idB, quantity: 30 },
    });
    assert.equal(bad.status, 409);
    assert.equal(bad.json.error, 'quantity_mismatch');

    const ok = await call('POST', `/staff/medications/${medId}/handoff`, {
      token: tokenA, idem: 'handoff-1', body: { toStaffId: idB, quantity: 25 },
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.toStaffId, idB);
  });

  it('家长视图含确认状态、执行记录与通知', async () => {
    // 制造一条异常通知
    await call('POST', `/staff/medications/${medId}/incidents`, {
      token: tokenB, idem: 'inc-1', body: { type: 'student_refused', detail: '学生想先写完作业' },
    });
    const r = await call('GET', '/guardian/view', { token: guardianToken });
    assert.equal(r.status, 200);
    const item = r.json.students.find((x: any) => x.medication_id === medId);
    assert.ok(item);
    assert.equal(item.confirmation.result, 'verified');
    assert.equal(item.currentInstruction.version, 1);
    assert.ok(item.recentExecutions.length >= 1);
    assert.ok(item.recentIncidents.some((i: any) => i.type === 'student_refused'));
    assert.ok(item.notifications.some((n: any) => n.type === 'incident_student_refused'));
  });

  it('审计视图可从执行追到授权版本、核对人员、交接链、剩余数量', async () => {
    const audit = await call('GET', `/staff/medications/${medId}/audit`, { token: tokenA });
    assert.equal(audit.status, 200);
    assert.equal(audit.json.remainingQuantity, 25);
    assert.equal(audit.json.authorizations[0].verifications[0].staff1Name, '周老师');
    const chainTypes = audit.json.custodyChain.map((c: any) => c.type);
    assert.deepEqual(chainTypes, ['receive', 'handoff']);

    const execId = audit.json.executions[0].id;
    const trace = await call(`GET`, `/staff/executions/${execId}/trace`, { token: tokenA });
    assert.equal(trace.status, 200);
    assert.equal(trace.json.authorization.dose_text, '5ml');
    assert.equal(trace.json.verifications[0].staff1_name, '周老师');
    assert.equal(trace.json.currentRemainingQuantity, 25);
  });

  it('标签剂量与线上指示冲突 → 冻结并通知负责人', async () => {
    const reg = await call('POST', '/guardian/medications', {
      token: guardianToken,
      body: {
        studentId, packageCode: 'BOX-10', labelDrugName: '布洛芬', labelDoseText: '10ml',
        expiryDate: '2027-06-01', storageRequirement: 'room_temp', initialQuantity: 10, quantityUnit: 'ml',
        instruction, // 指示 5ml vs 标签 10ml
      },
    });
    const id = reg.json.medicationId;
    await call('POST', `/staff/medications/${id}/receive`, { token: tokenA, body: { packageIntact: true, storageMet: true } });
    const v = await call('POST', `/staff/medications/${id}/verify`, { token: tokenA, body: { staff1Id: idA, staff2Id: idB, storageMet: true } });
    assert.equal(v.json.result, 'conflict');

    const frozen = await call('POST', `/staff/medications/${id}/execute`, { token: tokenA, body: { scheduledTime: '16:30', administeredQty: 5 } });
    assert.equal(frozen.status, 409);
    assert.equal(frozen.json.error, 'medication_frozen');

    const notifs = await call('GET', '/staff/notifications', { token: respToken });
    assert.ok(notifs.json.notifications.some((n: any) => n.type === 'verification_conflict'));
  });

  it('离线补传接口：历史执行入库并标记 backfilled', async () => {
    // 先把药品交回 A 持有以便执行
    await call('POST', `/staff/medications/${medId}/handoff`, { token: tokenB, idem: 'handoff-2', body: { toStaffId: idA, quantity: 25 } });
    const r = await call('POST', `/staff/medications/${medId}/backfill`, {
      token: tokenA,
      body: {
        events: [
          { kind: 'execution', clientEventId: 'offline-1', deviceId: 'pad-1', occurredAt: '2026-09-17T09:00:00.000Z', scheduledTime: '16:30', administeredQty: 5 },
          { kind: 'incident', clientEventId: 'offline-2', deviceId: 'pad-1', occurredAt: '2026-09-17T10:00:00.000Z', type: 'missed_dose' },
        ],
      },
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.processed, 2);
    assert.equal(r.json.results[0].backfilled, true);
  });
});
