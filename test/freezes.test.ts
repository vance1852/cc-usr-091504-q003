import { describe, expect, it } from 'vitest';
import { executePayload, headers, IDS, makeApp, setupInCustody } from './helpers';

/** 提交+确认指示，但尚未接收 */
async function setupSubmitted(app: any, quantity = 10) {
  const medRes = await app.inject({
    method: 'POST', url: '/api/medications', headers: headers(IDS.parent1),
    payload: {
      student_id: IDS.stu1, drug_name: '小儿止咳糖浆', drug_identity: '120ml/瓶 厂家C 批号D9',
      expiry_date: '2027-03-31', storage_condition: '阴凉干燥处', quantity_total: quantity,
    },
  });
  const medId = medRes.json().id as string;
  const authRes = await app.inject({
    method: 'POST', url: `/api/medications/${medId}/authorizations`, headers: headers(IDS.parent1),
    payload: {
      written_instruction: '每日一次，每次5ml', dose_quantity: 1, schedule_slots: ['12:00'],
      valid_from: '2026-09-01T00:00:00Z', valid_until: '2026-12-31T23:59:59Z',
      emergency_contact_name: '张家长', emergency_contact_phone: '13800000000',
    },
  });
  const authId = authRes.json().id as string;
  await app.inject({ method: 'POST', url: `/api/authorizations/${authId}/confirm`, headers: headers(IDS.staff1) });
  return { medId, authId };
}

describe('冻结：信息冲突 / 授权到期 / 保管条件失效 / 包装破损', () => {
  it('开场场景：药盒标签与线上留言剂量不一致 → 接收入账但冻结执行，通知负责人，解除后放行', async () => {
    const { app } = makeApp();
    const { medId } = await setupSubmitted(app);

    // 值班老师接收时发现标签剂量与线上指示不一致
    const receive = await app.inject({
      method: 'POST', url: `/api/medications/${medId}/receive`, headers: headers(IDS.staff1),
      payload: {
        location: '医务室药柜A',
        quantity_counted: 10,
        label_conflict_detail: '药盒标签写每次10ml，线上指示写每次5ml',
      },
    });
    expect(receive.statusCode).toBe(201);
    expect(receive.json().medication.status).toBe('RECEIVED');
    expect(receive.json().medication.active_freezes).toHaveLength(1);
    expect(receive.json().medication.active_freezes[0].reason).toBe('INFO_CONFLICT');

    // 冻结期间双人核对被拒（不能进入可执行状态）
    const check = await app.inject({
      method: 'POST', url: `/api/medications/${medId}/dual-check`, headers: headers(IDS.staff1),
      payload: { witness_id: IDS.staff2 },
    });
    expect(check.statusCode).toBe(409);
    expect(check.json().error.code).toBe('MEDICATION_FROZEN');

    // 负责人与家长都收到异常通知
    const mgrNotes = await app.inject({ method: 'GET', url: '/api/notifications', headers: headers(IDS.manager) });
    expect(mgrNotes.json().notifications.some((n: any) => n.kind === 'FREEZE_RAISED' && n.message.includes('10ml'))).toBe(true);
    const parentNotes = await app.inject({ method: 'GET', url: '/api/notifications', headers: headers(IDS.parent1) });
    expect(parentNotes.json().notifications.some((n: any) => n.kind === 'FREEZE_RAISED')).toBe(true);

    // 值班老师无权解除冻结，负责人核实后解除
    const freezeId = receive.json().medication.active_freezes[0].id;
    const staffResolve = await app.inject({
      method: 'POST', url: `/api/freezes/${freezeId}/resolve`, headers: headers(IDS.staff1),
      payload: { resolution_note: '试图越权解除' },
    });
    expect(staffResolve.statusCode).toBe(403);

    const resolve = await app.inject({
      method: 'POST', url: `/api/freezes/${freezeId}/resolve`, headers: headers(IDS.manager),
      payload: { resolution_note: '已与家长电话核实，以线上书面指示5ml为准，标签为旧包装' },
    });
    expect(resolve.statusCode).toBe(200);
    expect(resolve.json().status).toBe('RESOLVED');

    // 解除后正常走完流程
    const check2 = await app.inject({
      method: 'POST', url: `/api/medications/${medId}/dual-check`, headers: headers(IDS.staff1),
      payload: { witness_id: IDS.staff2 },
    });
    expect(check2.statusCode).toBe(201);
    const exec = await app.inject({
      method: 'POST', url: `/api/medications/${medId}/execute`, headers: headers(IDS.staff1),
      payload: executePayload({ scheduled_slot: '12:00' }),
    });
    expect(exec.statusCode).toBe(201);
  });

  it('实收数量与申报不符：不建立保管记录，直接冻结并通知', async () => {
    const { app } = makeApp();
    const { medId } = await setupSubmitted(app, 10);

    const receive = await app.inject({
      method: 'POST', url: `/api/medications/${medId}/receive`, headers: headers(IDS.staff1),
      payload: { location: '医务室', quantity_counted: 8 },
    });
    expect(receive.statusCode).toBe(409);
    expect(receive.json().error.code).toBe('QUANTITY_MISMATCH');

    const med = await app.inject({ method: 'GET', url: `/api/medications/${medId}`, headers: headers(IDS.staff1) });
    expect(med.json().status).toBe('SUBMITTED'); // 未入账
    expect(med.json().active_freezes[0].reason).toBe('INFO_CONFLICT');
  });

  it('授权到期：执行被拒并自动冻结，续期新版本确认后恢复', async () => {
    const { app } = makeApp();
    // 授权昨天已到期
    const { medId } = await setupInCustody(app, { validUntil: '2026-09-19T23:59:59Z' });

    const exec = await app.inject({
      method: 'POST', url: `/api/medications/${medId}/execute`, headers: headers(IDS.staff1),
      payload: executePayload(),
    });
    expect(exec.statusCode).toBe(409);
    expect(exec.json().error.code).toBe('AUTH_EXPIRED');

    // 自动冻结 + 通知负责人
    const med = await app.inject({ method: 'GET', url: `/api/medications/${medId}`, headers: headers(IDS.staff1) });
    const freeze = med.json().active_freezes.find((f: any) => f.reason === 'AUTH_EXPIRED');
    expect(freeze).toBeTruthy();
    const mgrNotes = await app.inject({ method: 'GET', url: '/api/notifications', headers: headers(IDS.manager) });
    expect(mgrNotes.json().notifications.some((n: any) => n.kind === 'FREEZE_RAISED')).toBe(true);

    // 家长续期（提交 v2），校方确认，负责人解除全部冻结后恢复执行
    const auth2 = await app.inject({
      method: 'POST', url: `/api/medications/${medId}/authorizations`, headers: headers(IDS.parent1),
      payload: {
        written_instruction: '每日两次，每次1袋，饭后温水送服', dose_quantity: 1, schedule_slots: ['09:00', '15:00'],
        valid_from: '2026-09-20T00:00:00Z', valid_until: '2026-10-31T23:59:59Z',
        emergency_contact_name: '张家长', emergency_contact_phone: '13800000000',
      },
    });
    expect(auth2.statusCode).toBe(201);
    await app.inject({ method: 'POST', url: `/api/authorizations/${auth2.json().id}/confirm`, headers: headers(IDS.staff1) });
    const frozenView = await app.inject({ method: 'GET', url: `/api/medications/${medId}`, headers: headers(IDS.staff1) });
    for (const f of frozenView.json().active_freezes) {
      const r = await app.inject({
        method: 'POST', url: `/api/freezes/${f.id}/resolve`, headers: headers(IDS.manager),
        payload: { resolution_note: '家长已续期，新版本已确认，核实无误' },
      });
      expect(r.statusCode).toBe(200);
    }

    const exec2 = await app.inject({
      method: 'POST', url: `/api/medications/${medId}/execute`, headers: headers(IDS.staff1),
      payload: executePayload(),
    });
    expect(exec2.statusCode).toBe(201);
  });

  it('药品过有效期：执行被拒并自动冻结', async () => {
    const { app } = makeApp();
    const { medId } = await setupInCustody(app, { expiryDate: '2026-09-19' });
    const exec = await app.inject({
      method: 'POST', url: `/api/medications/${medId}/execute`, headers: headers(IDS.staff1),
      payload: executePayload(),
    });
    expect(exec.statusCode).toBe(409);
    expect(exec.json().error.code).toBe('MEDICATION_EXPIRED');
  });

  it('保管条件失效 / 包装破损：人工上报冻结，阻断执行', async () => {
    const { app } = makeApp();
    const { medId } = await setupInCustody(app);

    const freeze = await app.inject({
      method: 'POST', url: `/api/medications/${medId}/freezes`, headers: headers(IDS.staff2),
      payload: { reason: 'STORAGE_FAILURE', detail: '冷藏柜夜间断电，温度超出2-8℃范围' },
    });
    expect(freeze.statusCode).toBe(201);

    const exec = await app.inject({
      method: 'POST', url: `/api/medications/${medId}/execute`, headers: headers(IDS.staff1),
      payload: executePayload(),
    });
    expect(exec.statusCode).toBe(409);
    expect(exec.json().error.code).toBe('MEDICATION_FROZEN');

    // 同一原因重复上报不产生第二条冻结
    const again = await app.inject({
      method: 'POST', url: `/api/medications/${medId}/freezes`, headers: headers(IDS.staff3),
      payload: { reason: 'STORAGE_FAILURE', detail: '再次确认温度异常' },
    });
    expect(again.json().id).toBe(freeze.json().id);

    // 包装破损是另一种原因，可并存
    const damaged = await app.inject({
      method: 'POST', url: `/api/medications/${medId}/freezes`, headers: headers(IDS.staff3),
      payload: { reason: 'PACKAGE_DAMAGED', detail: '药瓶瓶盖开裂' },
    });
    expect(damaged.statusCode).toBe(201);
    const med = await app.inject({ method: 'GET', url: `/api/medications/${medId}`, headers: headers(IDS.staff1) });
    expect(med.json().active_freezes).toHaveLength(2);
  });
});
