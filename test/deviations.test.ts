import { describe, expect, it } from 'vitest';
import { executePayload, headers, IDS, makeApp, setupInCustody } from './helpers';

describe('差错事件（追加式）', () => {
  it('漏执行、学生拒绝、用量误差都以追加记录处理，原执行记录不变', async () => {
    const { app, db } = makeApp();
    const { medId } = await setupInCustody(app, { quantity: 10 });

    // 09:00 正常执行
    const exec = await app.inject({
      method: 'POST', url: `/api/medications/${medId}/execute`, headers: headers(IDS.staff1),
      payload: executePayload(),
    });
    const execId = exec.json().event.id as string;

    // 用量误差：实际给了2袋，追加差错事件，原记录不删不改
    const doseErr = await app.inject({
      method: 'POST', url: `/api/medications/${medId}/deviations`, headers: headers(IDS.staff1),
      payload: { type: 'DOSE_ERROR', detail: '实际误给2袋，已观察学生状态并联系家长', related_event_id: execId },
    });
    expect(doseErr.statusCode).toBe(201);

    // 15:00 学生拒绝
    const refused = await app.inject({
      method: 'POST', url: `/api/medications/${medId}/deviations`, headers: headers(IDS.staff1),
      payload: { type: 'REFUSED', detail: '学生拒绝服用', scheduled_date: '2026-09-20', scheduled_slot: '15:00' },
    });
    expect(refused.statusCode).toBe(201);

    // 次日 09:00 漏执行
    const missed = await app.inject({
      method: 'POST', url: `/api/medications/${medId}/deviations`, headers: headers(IDS.staff2),
      payload: { type: 'MISSED', detail: '值班交接遗漏，未按时执行', scheduled_date: '2026-09-21', scheduled_slot: '09:00' },
    });
    expect(missed.statusCode).toBe(201);

    // 原执行记录完好，数量不变
    const event = db.prepare('SELECT * FROM custody_events WHERE id = ?').get(execId) as any;
    expect(event.quantity_after).toBe(9);
    const devCount = db.prepare('SELECT COUNT(*) AS c FROM deviations WHERE medication_id = ?').get(medId) as any;
    expect(devCount.c).toBe(3);

    // 审计：从该次执行可追到关联的误差事件
    const trace = await app.inject({ method: 'GET', url: `/api/audit/executions/${execId}`, headers: headers(IDS.auditor) });
    expect(trace.json().deviations).toHaveLength(1);
    expect(trace.json().deviations[0].type).toBe('DOSE_ERROR');

    // 家长与负责人都收到异常通知
    const parentNotes = await app.inject({ method: 'GET', url: '/api/notifications', headers: headers(IDS.parent1) });
    expect(parentNotes.json().notifications.filter((n: any) => n.kind === 'DEVIATION_REPORTED')).toHaveLength(3);
    const mgrNotes = await app.inject({ method: 'GET', url: '/api/notifications', headers: headers(IDS.manager) });
    expect(mgrNotes.json().notifications.filter((n: any) => n.kind === 'DEVIATION_REPORTED')).toHaveLength(3);

    // 家长端状态可见差错
    const pv = await app.inject({ method: 'GET', url: `/api/parent/students/${IDS.stu1}/status`, headers: headers(IDS.parent1) });
    expect(pv.json().medications[0].deviations).toHaveLength(3);
  });

  it('用量误差必须关联本药品的执行记录', async () => {
    const { app } = makeApp();
    const { medId } = await setupInCustody(app);
    const bad = await app.inject({
      method: 'POST', url: `/api/medications/${medId}/deviations`, headers: headers(IDS.staff1),
      payload: { type: 'DOSE_ERROR', detail: '误给', related_event_id: 'non-existent' },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('INVALID_RELATED_EVENT');

    const missing = await app.inject({
      method: 'POST', url: `/api/medications/${medId}/deviations`, headers: headers(IDS.staff1),
      payload: { type: 'DOSE_ERROR', detail: '误给' },
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.code).toBe('RELATED_EVENT_REQUIRED');
  });
});
