import { describe, expect, it } from 'vitest';
import { executePayload, headers, IDS, makeApp, setupInCustody } from './helpers';

describe('指示变更（版本化授权）', () => {
  it('家长提交新版本 → 自动冻结；确认新版后旧版作废；持旧版执行被拒', async () => {
    const { app } = makeApp();
    const { medId, authId: v1 } = await setupInCustody(app, { quantity: 10 });

    // v1 先正常执行一次
    const exec1 = await app.inject({
      method: 'POST', url: `/api/medications/${medId}/execute`, headers: headers(IDS.staff1),
      payload: executePayload({ authorization_id: v1 }),
    });
    expect(exec1.statusCode).toBe(201);

    // 家长提交 v2（剂量调整为2）→ 与现行确认版本并存，构成信息冲突 → 自动冻结
    const auth2Res = await app.inject({
      method: 'POST', url: `/api/medications/${medId}/authorizations`, headers: headers(IDS.parent1),
      payload: {
        written_instruction: '每日两次，每次2袋，饭后温水送服', dose_quantity: 2, schedule_slots: ['09:00', '15:00'],
        valid_from: '2026-09-20T00:00:00Z', valid_until: '2026-12-31T23:59:59Z',
        emergency_contact_name: '张家长', emergency_contact_phone: '13800000000',
      },
    });
    expect(auth2Res.statusCode).toBe(201);
    const v2 = auth2Res.json().id as string;
    expect(auth2Res.json().version).toBe(2);

    // 冻结期间任何执行都被阻断
    const blocked = await app.inject({
      method: 'POST', url: `/api/medications/${medId}/execute`, headers: headers(IDS.staff1),
      payload: executePayload({ scheduled_slot: '15:00' }),
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe('MEDICATION_FROZEN');

    // 校方确认 v2 → v1 自动作废
    const confirm = await app.inject({ method: 'POST', url: `/api/authorizations/${v2}/confirm`, headers: headers(IDS.staff1) });
    expect(confirm.statusCode).toBe(200);
    expect(confirm.json().status).toBe('CONFIRMED');

    // 负责人解除冻结
    const med = await app.inject({ method: 'GET', url: `/api/medications/${medId}`, headers: headers(IDS.staff1) });
    const freeze = med.json().active_freezes.find((f: any) => f.reason === 'INFO_CONFLICT');
    await app.inject({
      method: 'POST', url: `/api/freezes/${freeze.id}/resolve`, headers: headers(IDS.manager),
      payload: { resolution_note: '已与家长核实，按新版本 v2 执行' },
    });

    // 客户端仍持旧版本号 → 拒绝（防止按过期指示执行）
    const stale = await app.inject({
      method: 'POST', url: `/api/medications/${medId}/execute`, headers: headers(IDS.staff1),
      payload: executePayload({ scheduled_slot: '15:00', authorization_id: v1 }),
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('AUTH_SUPERSEDED');

    // 按 v2 执行：扣减新剂量 2
    const exec2 = await app.inject({
      method: 'POST', url: `/api/medications/${medId}/execute`, headers: headers(IDS.staff1),
      payload: executePayload({ scheduled_slot: '15:00', authorization_id: v2 }),
    });
    expect(exec2.statusCode).toBe(201);
    expect(exec2.json().event.quantity_after).toBe(10 - 1 - 2);

    // 审计视图可见两个版本的状态
    const trace = await app.inject({ method: 'GET', url: `/api/audit/medications/${medId}/trace`, headers: headers(IDS.auditor) });
    const versions = trace.json().authorizations.map((a: any) => [a.version, a.status]);
    expect(versions).toEqual([[1, 'SUPERSEDED'], [2, 'CONFIRMED']]);
    // 两次执行分别锚定各自版本
    const execs = trace.json().custody_chain.filter((e: any) => e.type === 'EXECUTE');
    expect(execs[0].authorization_id).toBe(v1);
    expect(execs[1].authorization_id).toBe(v2);
  });

  it('新版本一经提交即冻结，确认+解冻后才放行', async () => {
    const { app } = makeApp();
    const { medId } = await setupInCustody(app);
    await app.inject({
      method: 'POST', url: `/api/medications/${medId}/authorizations`, headers: headers(IDS.parent1),
      payload: {
        written_instruction: '每日两次，每次1袋', dose_quantity: 1, schedule_slots: ['09:00', '15:00'],
        valid_from: '2026-09-20T00:00:00Z', valid_until: '2026-12-31T23:59:59Z',
        emergency_contact_name: '张家长', emergency_contact_phone: '13800000000',
      },
    });
    const exec = await app.inject({
      method: 'POST', url: `/api/medications/${medId}/execute`, headers: headers(IDS.staff1),
      payload: executePayload(),
    });
    expect(exec.statusCode).toBe(409);
    expect(exec.json().error.code).toBe('MEDICATION_FROZEN');
  });
});
