import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { executePayload, headers, IDS, makeApp, setupInCustody } from './helpers';

describe('离线补传', () => {
  it('离线执行与差错事件补传入账，整批重传全部判重', async () => {
    const { app, db } = makeApp();
    const { medId } = await setupInCustody(app, { quantity: 10 });

    const ev1 = randomUUID(); // 昨天 09:00 的离线执行
    const ev2 = randomUUID(); // 昨天 15:00 学生拒绝（差错）
    const batch = {
      events: [
        {
          client_event_id: ev1, kind: 'EXECUTE', medication_id: medId,
          occurred_at: '2026-09-19T09:05:00.000Z',
          payload: { witness_id: IDS.staff2, scheduled_date: '2026-09-19', scheduled_slot: '09:00' },
        },
        {
          client_event_id: ev2, kind: 'DEVIATION', medication_id: medId,
          occurred_at: '2026-09-19T15:10:00.000Z',
          payload: { type: 'REFUSED', detail: '学生拒绝服用，已当场联系家长', scheduled_date: '2026-09-19', scheduled_slot: '15:00' },
        },
      ],
    };

    const first = await app.inject({ method: 'POST', url: '/api/events/batch', headers: headers(IDS.staff1), payload: batch });
    expect(first.statusCode).toBe(200);
    expect(first.json().results).toEqual([
      { client_event_id: ev1, status: 'applied', event_id: expect.any(String) },
      { client_event_id: ev2, status: 'applied', deviation_id: expect.any(String) },
    ]);

    // 数量只扣一次；差错不改变数量
    const med = db.prepare('SELECT quantity_remaining FROM medications WHERE id = ?').get(medId) as any;
    expect(med.quantity_remaining).toBe(9);

    // 整批重传 → 全部 duplicate，不产生第二次动作
    const replay = await app.inject({ method: 'POST', url: '/api/events/batch', headers: headers(IDS.staff1), payload: batch });
    expect(replay.json().results).toEqual([
      { client_event_id: ev1, status: 'duplicate' },
      { client_event_id: ev2, status: 'duplicate' },
    ]);
    const medAfter = db.prepare('SELECT quantity_remaining FROM medications WHERE id = ?').get(medId) as any;
    expect(medAfter.quantity_remaining).toBe(9);
    const execCount = db.prepare("SELECT COUNT(*) AS c FROM custody_events WHERE type = 'EXECUTE'").get() as any;
    expect(execCount.c).toBe(1);

    // 审计链路保留实际发生时间（occurred_at）与入账时间（recorded_at）
    const trace = await app.inject({ method: 'GET', url: `/api/audit/medications/${medId}/trace`, headers: headers(IDS.auditor) });
    const exec = trace.json().custody_chain.find((e: any) => e.type === 'EXECUTE');
    expect(exec.occurred_at).toBe('2026-09-19T09:05:00.000Z');
    expect(exec.recorded_at > exec.occurred_at).toBe(true);
    expect(trace.json().deviations).toHaveLength(1);
  });

  it('补传与线上记录冲突的时段被拒；过期授权的补传触发自动冻结', async () => {
    const { app } = makeApp();
    const { medId } = await setupInCustody(app, { quantity: 10 });

    // 线上已执行 09:00
    await app.inject({
      method: 'POST', url: `/api/medications/${medId}/execute`, headers: headers(IDS.staff1),
      payload: executePayload(),
    });

    const dupSlot = randomUUID();
    const expired = randomUUID();
    const res = await app.inject({
      method: 'POST', url: '/api/events/batch', headers: headers(IDS.staff1),
      payload: {
        events: [
          {
            client_event_id: dupSlot, kind: 'EXECUTE', medication_id: medId,
            occurred_at: '2026-09-20T09:10:00.000Z',
            payload: { witness_id: IDS.staff2, scheduled_date: '2026-09-20', scheduled_slot: '09:00' },
          },
          {
            client_event_id: expired, kind: 'EXECUTE', medication_id: medId,
            occurred_at: '2027-01-05T09:00:00.000Z', // 超出授权有效期 2026-12-31
            payload: { witness_id: IDS.staff2, scheduled_date: '2027-01-05', scheduled_slot: '09:00' },
          },
        ],
      },
    });
    const [r1, r2] = res.json().results;
    expect(r1).toMatchObject({ client_event_id: dupSlot, status: 'rejected', code: 'SLOT_ALREADY_EXECUTED' });
    expect(r2).toMatchObject({ client_event_id: expired, status: 'rejected', code: 'AUTH_EXPIRED' });

    // 过期补传触发了自动冻结
    const med = await app.inject({ method: 'GET', url: `/api/medications/${medId}`, headers: headers(IDS.staff1) });
    expect(med.json().active_freezes.some((f: any) => f.reason === 'AUTH_EXPIRED')).toBe(true);
  });
});
