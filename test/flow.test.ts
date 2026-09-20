import { describe, expect, it } from 'vitest';
import { executePayload, headers, IDS, makeApp, setupInCustody } from './helpers';

describe('完整流程：提交→确认→接收→双人核对→交接→执行→退回', () => {
  it('全链路状态与数量正确，家长与审计视图各自可见', async () => {
    const { app } = makeApp();
    const { medId, authId } = await setupInCustody(app, { quantity: 10 });

    // 跨班交接：陈老师(医务室) → 周老师(三年级二班教室)
    const handover = await app.inject({
      method: 'POST', url: `/api/medications/${medId}/handover`, headers: headers(IDS.staff1),
      payload: {
        from_custodian_id: IDS.staff1,
        to_custodian_id: IDS.staff3,
        to_location: '三年级二班教室',
        quantity_counted: 10,
      },
    });
    expect(handover.statusCode).toBe(201);
    expect(handover.json().event.type).toBe('HANDOVER');

    // 执行给药（双人：周老师执行，刘老师核对）
    const exec = await app.inject({
      method: 'POST', url: `/api/medications/${medId}/execute`, headers: headers(IDS.staff3),
      payload: executePayload({ authorization_id: authId }),
    });
    expect(exec.statusCode).toBe(201);
    const execEvent = exec.json().event;
    expect(execEvent.quantity_before).toBe(10);
    expect(execEvent.quantity_after).toBe(9);
    expect(execEvent.authorization_id).toBe(authId);

    // 家长端：看到确认状态与执行通知
    const parentView = await app.inject({
      method: 'GET', url: `/api/parent/students/${IDS.stu1}/status`, headers: headers(IDS.parent1),
    });
    expect(parentView.statusCode).toBe(200);
    const pv = parentView.json();
    expect(pv.medications).toHaveLength(1);
    expect(pv.medications[0].status).toBe('IN_CUSTODY');
    expect(pv.medications[0].quantity_remaining).toBe(9);
    expect(pv.medications[0].current_custodian_name).toBe('周老师');
    expect(pv.medications[0].confirmed_authorization.version).toBe(1);
    expect(pv.medications[0].recent_executions).toHaveLength(1);
    expect(pv.notifications.some((n: any) => n.kind === 'EXECUTION_CONFIRMED')).toBe(true);

    // 审计视图：从一次执行追到授权版本、核对人员、交接链、剩余数量
    const trace = await app.inject({
      method: 'GET', url: `/api/audit/executions/${execEvent.id}`, headers: headers(IDS.auditor),
    });
    expect(trace.statusCode).toBe(200);
    const t = trace.json();
    expect(t.authorization.version).toBe(1);
    expect(t.execution.actor_name).toBe('周老师');
    expect(t.execution.witness_name).toBe('刘老师');
    expect(t.handover_chain).toHaveLength(1);
    expect(t.handover_chain[0].from_custodian_name).toBe('陈老师');
    expect(t.handover_chain[0].to_custodian_name).toBe('周老师');
    expect(t.quantity_after).toBe(9);
    expect(t.quantity_remaining_now).toBe(9);

    // 药品维度全链路
    const medTrace = await app.inject({
      method: 'GET', url: `/api/audit/medications/${medId}/trace`, headers: headers(IDS.auditor),
    });
    expect(medTrace.json().custody_chain.map((e: any) => e.type)).toEqual([
      'RECEIVE', 'DUAL_CHECK', 'HANDOVER', 'EXECUTE',
    ]);

    // 退回家长
    const ret = await app.inject({
      method: 'POST', url: `/api/medications/${medId}/return`, headers: headers(IDS.staff3),
      payload: { quantity_returned: 9 },
    });
    expect(ret.statusCode).toBe(201);
    const after = await app.inject({ method: 'GET', url: `/api/medications/${medId}`, headers: headers(IDS.staff1) });
    expect(after.json().status).toBe('RETURNED');
    expect(after.json().quantity_remaining).toBe(0);
    expect(after.json().current_custodian_id).toBeNull();
  });

  it('退回后禁止再执行；退回数量不符被拒', async () => {
    const { app } = makeApp();
    const { medId } = await setupInCustody(app, { quantity: 5 });

    const wrongQty = await app.inject({
      method: 'POST', url: `/api/medications/${medId}/return`, headers: headers(IDS.staff1),
      payload: { quantity_returned: 3 },
    });
    expect(wrongQty.statusCode).toBe(409);
    expect(wrongQty.json().error.code).toBe('QUANTITY_MISMATCH');

    await app.inject({
      method: 'POST', url: `/api/medications/${medId}/return`, headers: headers(IDS.staff1),
      payload: { quantity_returned: 5 },
    });
    const exec = await app.inject({
      method: 'POST', url: `/api/medications/${medId}/execute`, headers: headers(IDS.staff1),
      payload: executePayload(),
    });
    expect(exec.statusCode).toBe(409);
    expect(exec.json().error.code).toBe('INVALID_STATE');
  });

  it('双人核对与执行都要求两名不同的校方人员', async () => {
    const { app } = makeApp();
    const { medId } = await setupInCustody(app);

    const samePersonExec = await app.inject({
      method: 'POST', url: `/api/medications/${medId}/execute`, headers: headers(IDS.staff1),
      payload: executePayload({ witness_id: IDS.staff1 }),
    });
    expect(samePersonExec.statusCode).toBe(400);
    expect(samePersonExec.json().error.code).toBe('SAME_PERSON_NOT_ALLOWED');
  });
});
