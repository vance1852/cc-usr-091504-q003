import { describe, expect, it } from 'vitest';
import { executePayload, headers, IDS, makeApp, setupInCustody } from './helpers';

describe('访问控制', () => {
  it('未认证请求被拒', async () => {
    const { app } = makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/notifications' });
    expect(res.statusCode).toBe(401);
    const bad = await app.inject({ method: 'GET', url: '/api/notifications', headers: { 'x-actor-id': 'nobody' } });
    expect(bad.statusCode).toBe(401);
  });

  it('家长只能查看本人孩子', async () => {
    const { app } = makeApp();
    await setupInCustody(app); // stu1 属于 parent1
    const forbidden = await app.inject({
      method: 'GET', url: `/api/parent/students/${IDS.stu1}/status`, headers: headers(IDS.parent2),
    });
    expect(forbidden.statusCode).toBe(403);

    const own = await app.inject({
      method: 'GET', url: `/api/parent/students/${IDS.stu1}/status`, headers: headers(IDS.parent1),
    });
    expect(own.statusCode).toBe(200);
  });

  it('家长不能为他人孩子提交药品，也不能执行校方动作', async () => {
    const { app } = makeApp();
    const wrongParent = await app.inject({
      method: 'POST', url: '/api/medications', headers: headers(IDS.parent1),
      payload: {
        student_id: IDS.stu2, drug_name: 'X', drug_identity: 'Y',
        expiry_date: '2027-01-01', storage_condition: '常温', quantity_total: 1,
      },
    });
    expect(wrongParent.statusCode).toBe(403);

    const { medId } = await setupInCustody(app);
    const parentExec = await app.inject({
      method: 'POST', url: `/api/medications/${medId}/execute`, headers: headers(IDS.parent1),
      payload: executePayload(),
    });
    expect(parentExec.statusCode).toBe(403);
  });

  it('审计视图仅审计与负责人可见；审计不能执行保管动作', async () => {
    const { app } = makeApp();
    const { medId } = await setupInCustody(app);

    const parentTrace = await app.inject({
      method: 'GET', url: `/api/audit/medications/${medId}/trace`, headers: headers(IDS.parent1),
    });
    expect(parentTrace.statusCode).toBe(403);

    const staffTrace = await app.inject({
      method: 'GET', url: `/api/audit/medications/${medId}/trace`, headers: headers(IDS.staff1),
    });
    expect(staffTrace.statusCode).toBe(403);

    const ok = await app.inject({
      method: 'GET', url: `/api/audit/medications/${medId}/trace`, headers: headers(IDS.auditor),
    });
    expect(ok.statusCode).toBe(200);

    const auditorExec = await app.inject({
      method: 'POST', url: `/api/medications/${medId}/execute`, headers: headers(IDS.auditor),
      payload: executePayload(),
    });
    expect(auditorExec.statusCode).toBe(403);
  });

  it('家长不能确认指示版本', async () => {
    const { app } = makeApp();
    const medRes = await app.inject({
      method: 'POST', url: '/api/medications', headers: headers(IDS.parent1),
      payload: {
        student_id: IDS.stu1, drug_name: 'X', drug_identity: 'Y',
        expiry_date: '2027-01-01', storage_condition: '常温', quantity_total: 1,
      },
    });
    const authRes = await app.inject({
      method: 'POST', url: `/api/medications/${medRes.json().id}/authorizations`, headers: headers(IDS.parent1),
      payload: {
        written_instruction: '每日一次', dose_quantity: 1, schedule_slots: ['09:00'],
        valid_from: '2026-09-01T00:00:00Z', valid_until: '2026-12-31T23:59:59Z',
        emergency_contact_name: '张家长', emergency_contact_phone: '13800000000',
      },
    });
    const confirm = await app.inject({
      method: 'POST', url: `/api/authorizations/${authRes.json().id}/confirm`, headers: headers(IDS.parent1),
    });
    expect(confirm.statusCode).toBe(403);
  });
});
