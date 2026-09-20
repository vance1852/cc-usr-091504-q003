import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { executePayload, headers, IDS, makeApp, setupInCustody } from './helpers';

describe('幂等与不可变性', () => {
  it('重复扫码（同一幂等键）返回首次结果，不产生第二次动作', async () => {
    const { app, db } = makeApp();
    const { medId } = await setupInCustody(app, { quantity: 10 });
    const key = randomUUID();

    const first = await app.inject({
      method: 'POST', url: `/api/medications/${medId}/execute`, headers: headers(IDS.staff1, key),
      payload: executePayload(),
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: 'POST', url: `/api/medications/${medId}/execute`, headers: headers(IDS.staff1, key),
      payload: executePayload(),
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().deduplicated).toBe(true);
    expect(second.json().event.id).toBe(first.json().event.id);

    const count = db.prepare("SELECT COUNT(*) AS c FROM custody_events WHERE type = 'EXECUTE'").get() as any;
    expect(count.c).toBe(1);
    const med = db.prepare('SELECT quantity_remaining FROM medications WHERE id = ?').get(medId) as any;
    expect(med.quantity_remaining).toBe(9);
  });

  it('换了幂等键也无法对同一时段重复执行（自然键去重）', async () => {
    const { app, db } = makeApp();
    const { medId } = await setupInCustody(app, { quantity: 10 });

    await app.inject({
      method: 'POST', url: `/api/medications/${medId}/execute`, headers: headers(IDS.staff1),
      payload: executePayload(),
    });
    const dup = await app.inject({
      method: 'POST', url: `/api/medications/${medId}/execute`, headers: headers(IDS.staff1, randomUUID()),
      payload: executePayload(), // 同一 scheduled_date + scheduled_slot
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('SLOT_ALREADY_EXECUTED');

    const med = db.prepare('SELECT quantity_remaining FROM medications WHERE id = ?').get(medId) as any;
    expect(med.quantity_remaining).toBe(9);
  });

  it('接收动作同样幂等', async () => {
    const { app, db } = makeApp();
    // 只提交，不接收
    const medRes = await app.inject({
      method: 'POST', url: '/api/medications', headers: headers(IDS.parent1),
      payload: {
        student_id: IDS.stu1, drug_name: '维生素D滴剂', drug_identity: '30粒/盒 厂家E',
        expiry_date: '2027-06-30', storage_condition: '常温避光', quantity_total: 30,
      },
    });
    const medId = medRes.json().id;
    const key = randomUUID();
    const r1 = await app.inject({
      method: 'POST', url: `/api/medications/${medId}/receive`, headers: headers(IDS.staff1, key),
      payload: { location: '医务室', quantity_counted: 30 },
    });
    const r2 = await app.inject({
      method: 'POST', url: `/api/medications/${medId}/receive`, headers: headers(IDS.staff1, key),
      payload: { location: '医务室', quantity_counted: 30 },
    });
    expect(r1.statusCode).toBe(201);
    expect(r2.statusCode).toBe(200);
    expect(r2.json().deduplicated).toBe(true);
    const count = db.prepare("SELECT COUNT(*) AS c FROM custody_events WHERE type = 'RECEIVE'").get() as any;
    expect(count.c).toBe(1);
  });

  it('执行记录与差错事件在存储层不可修改、不可删除', async () => {
    const { app, db } = makeApp();
    const { medId } = await setupInCustody(app);
    await app.inject({
      method: 'POST', url: `/api/medications/${medId}/execute`, headers: headers(IDS.staff1),
      payload: executePayload(),
    });
    await app.inject({
      method: 'POST', url: `/api/medications/${medId}/deviations`, headers: headers(IDS.staff1),
      payload: { type: 'REFUSED', detail: '学生拒绝服用，已联系家长', scheduled_date: '2026-09-20', scheduled_slot: '15:00' },
    });

    expect(() => db.prepare("UPDATE custody_events SET note = '篡改'").run()).toThrow(/追加式账本/);
    expect(() => db.prepare('DELETE FROM custody_events').run()).toThrow(/追加式账本/);
    expect(() => db.prepare("UPDATE deviations SET detail = '篡改'").run()).toThrow(/追加式账本/);
    expect(() => db.prepare('DELETE FROM deviations').run()).toThrow(/追加式账本/);

    // 原记录完好
    const event = db.prepare("SELECT * FROM custody_events WHERE type = 'EXECUTE'").get() as any;
    expect(event.quantity_after).toBe(9);
  });

  it('缺少 idempotency-key 的保管动作被拒绝', async () => {
    const { app } = makeApp();
    const { medId } = await setupInCustody(app);
    const res = await app.inject({
      method: 'POST', url: `/api/medications/${medId}/execute`,
      headers: { 'x-actor-id': IDS.staff1 }, // 无幂等键
      payload: executePayload(),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });
});
