import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { executePayload, headers, IDS, makeApp, setupInCustody } from './helpers';

describe('并发领取与交接一致性', () => {
  it('并发交接同一药品：只有一笔成功，保管人唯一', async () => {
    const { app } = makeApp();
    const { medId } = await setupInCustody(app, { quantity: 10 });

    // 两位老师同时发起交接（都声称从陈老师处接手）
    const [r1, r2] = await Promise.all([
      app.inject({
        method: 'POST', url: `/api/medications/${medId}/handover`, headers: headers(IDS.staff1, randomUUID()),
        payload: { from_custodian_id: IDS.staff1, to_custodian_id: IDS.staff2, to_location: '二年级一班教室', quantity_counted: 10 },
      }),
      app.inject({
        method: 'POST', url: `/api/medications/${medId}/handover`, headers: headers(IDS.staff1, randomUUID()),
        payload: { from_custodian_id: IDS.staff1, to_custodian_id: IDS.staff3, to_location: '三年级二班教室', quantity_counted: 10 },
      }),
    ]);
    const statuses = [r1.statusCode, r2.statusCode].sort();
    expect(statuses).toEqual([201, 409]);

    const med = await app.inject({ method: 'GET', url: `/api/medications/${medId}`, headers: headers(IDS.staff1) });
    const winner = r1.statusCode === 201 ? IDS.staff2 : IDS.staff3;
    expect(med.json().current_custodian_id).toBe(winner);
  });

  it('交接时清点数量与账面不符被拒，保证数量连续', async () => {
    const { app } = makeApp();
    const { medId } = await setupInCustody(app, { quantity: 10 });
    // 先执行一次，剩余 9
    await app.inject({
      method: 'POST', url: `/api/medications/${medId}/execute`, headers: headers(IDS.staff1),
      payload: executePayload(),
    });
    const bad = await app.inject({
      method: 'POST', url: `/api/medications/${medId}/handover`, headers: headers(IDS.staff1),
      payload: { from_custodian_id: IDS.staff1, to_custodian_id: IDS.staff2, to_location: '二年级一班', quantity_counted: 10 },
    });
    expect(bad.statusCode).toBe(409);
    expect(bad.json().error.code).toBe('QUANTITY_MISMATCH');

    const good = await app.inject({
      method: 'POST', url: `/api/medications/${medId}/handover`, headers: headers(IDS.staff1),
      payload: { from_custodian_id: IDS.staff1, to_custodian_id: IDS.staff2, to_location: '二年级一班', quantity_counted: 9 },
    });
    expect(good.statusCode).toBe(201);
  });

  it('基于过期保管人信息的交接被拒（防重放）', async () => {
    const { app } = makeApp();
    const { medId } = await setupInCustody(app, { quantity: 10 });
    // 陈老师 → 刘老师
    await app.inject({
      method: 'POST', url: `/api/medications/${medId}/handover`, headers: headers(IDS.staff1),
      payload: { from_custodian_id: IDS.staff1, to_custodian_id: IDS.staff2, to_location: '二年级一班', quantity_counted: 10 },
    });
    // 再次以陈老师为交出方 → 账面保管人已是刘老师
    const stale = await app.inject({
      method: 'POST', url: `/api/medications/${medId}/handover`, headers: headers(IDS.staff1, randomUUID()),
      payload: { from_custodian_id: IDS.staff1, to_custodian_id: IDS.staff3, to_location: '三年级二班', quantity_counted: 10 },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('CUSTODY_MISMATCH');
  });

  it('并发执行同一时段：只有一笔入账', async () => {
    const { app, db } = makeApp();
    const { medId } = await setupInCustody(app, { quantity: 10 });

    const [e1, e2] = await Promise.all([
      app.inject({
        method: 'POST', url: `/api/medications/${medId}/execute`, headers: headers(IDS.staff1, randomUUID()),
        payload: executePayload(),
      }),
      app.inject({
        method: 'POST', url: `/api/medications/${medId}/execute`, headers: headers(IDS.staff2, randomUUID()),
        payload: executePayload({ witness_id: IDS.staff3 }),
      }),
    ]);
    const statuses = [e1.statusCode, e2.statusCode].sort();
    expect(statuses).toEqual([201, 409]);

    const count = db.prepare("SELECT COUNT(*) AS c FROM custody_events WHERE type = 'EXECUTE'").get() as any;
    expect(count.c).toBe(1);
    const med = db.prepare('SELECT quantity_remaining FROM medications WHERE id = ?').get(medId) as any;
    expect(med.quantity_remaining).toBe(9);
  });

  it('冻结期间仍允许交接（保管责任必须连续），但执行仍被阻断', async () => {
    const { app } = makeApp();
    const { medId } = await setupInCustody(app, { quantity: 10 });
    await app.inject({
      method: 'POST', url: `/api/medications/${medId}/freezes`, headers: headers(IDS.staff1),
      payload: { reason: 'PACKAGE_DAMAGED', detail: '外包装破损' },
    });

    const handover = await app.inject({
      method: 'POST', url: `/api/medications/${medId}/handover`, headers: headers(IDS.staff1),
      payload: { from_custodian_id: IDS.staff1, to_custodian_id: IDS.staff2, to_location: '医务室隔离柜', quantity_counted: 10 },
    });
    expect(handover.statusCode).toBe(201);

    const exec = await app.inject({
      method: 'POST', url: `/api/medications/${medId}/execute`, headers: headers(IDS.staff2),
      payload: executePayload({ witness_id: IDS.staff1 }),
    });
    expect(exec.statusCode).toBe(409);
    expect(exec.json().error.code).toBe('MEDICATION_FROZEN');
  });
});
