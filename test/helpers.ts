import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { createDb, seed, type DB } from '../src/db';

export const IDS = {
  parent1: 'u-parent-1',
  parent2: 'u-parent-2',
  staff1: 'u-staff-1',
  staff2: 'u-staff-2',
  staff3: 'u-staff-3',
  manager: 'u-mgr-1',
  auditor: 'u-audit-1',
  stu1: 'stu-1',
  stu2: 'stu-2',
} as const;

/** 固定时钟：2026-09-20T08:00:00Z，授权/有效期均围绕它构造 */
export const NOW = new Date('2026-09-20T08:00:00.000Z');

export function makeApp(now: Date = NOW): { app: FastifyInstance; db: DB } {
  const db = createDb(':memory:');
  seed(db);
  const app = buildApp({ db, now: () => now });
  return { app, db };
}

export function headers(actorId: string, idemKey: string | null = randomUUID()): Record<string, string> {
  const h: Record<string, string> = { 'x-actor-id': actorId };
  if (idemKey) h['idempotency-key'] = idemKey;
  return h;
}

export interface SetupOptions {
  quantity?: number;
  dose?: number;
  validFrom?: string;
  validUntil?: string;
  expiryDate?: string;
  studentId?: string;
  parentId?: string;
}

/** 走完 提交→指示→确认→接收→双人核对，返回处于 IN_CUSTODY 状态的药品与授权 */
export async function setupInCustody(
  app: FastifyInstance,
  opts: SetupOptions = {},
): Promise<{ medId: string; authId: string }> {
  const quantity = opts.quantity ?? 10;
  const parentId = opts.parentId ?? IDS.parent1;
  const studentId = opts.studentId ?? IDS.stu1;

  const medRes = await app.inject({
    method: 'POST', url: '/api/medications', headers: headers(parentId),
    payload: {
      student_id: studentId,
      drug_name: '布洛芬混悬液',
      drug_identity: '100ml/瓶 厂家A 批号B202601',
      expiry_date: opts.expiryDate ?? '2027-01-31',
      storage_condition: '25℃以下避光保存',
      quantity_total: quantity,
    },
  });
  if (medRes.statusCode !== 201) throw new Error(`setup submitMedication failed: ${medRes.body}`);
  const medId = medRes.json().id as string;

  const authRes = await app.inject({
    method: 'POST', url: `/api/medications/${medId}/authorizations`, headers: headers(parentId),
    payload: {
      written_instruction: '每日两次，每次1袋，饭后温水送服',
      dose_quantity: opts.dose ?? 1,
      schedule_slots: ['09:00', '15:00'],
      valid_from: opts.validFrom ?? '2026-09-01T00:00:00Z',
      valid_until: opts.validUntil ?? '2026-12-31T23:59:59Z',
      emergency_contact_name: '张家长',
      emergency_contact_phone: '13800000000',
    },
  });
  if (authRes.statusCode !== 201) throw new Error(`setup submitAuthorization failed: ${authRes.body}`);
  const authId = authRes.json().id as string;

  const confirmRes = await app.inject({
    method: 'POST', url: `/api/authorizations/${authId}/confirm`, headers: headers(IDS.staff1),
  });
  if (confirmRes.statusCode !== 200) throw new Error(`setup confirm failed: ${confirmRes.body}`);

  const receiveRes = await app.inject({
    method: 'POST', url: `/api/medications/${medId}/receive`, headers: headers(IDS.staff1),
    payload: { location: '医务室药柜A', quantity_counted: quantity },
  });
  if (receiveRes.statusCode !== 201) throw new Error(`setup receive failed: ${receiveRes.body}`);

  const checkRes = await app.inject({
    method: 'POST', url: `/api/medications/${medId}/dual-check`, headers: headers(IDS.staff1),
    payload: { witness_id: IDS.staff2 },
  });
  if (checkRes.statusCode !== 201) throw new Error(`setup dual-check failed: ${checkRes.body}`);

  return { medId, authId };
}

export function executePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    witness_id: IDS.staff2,
    scheduled_date: '2026-09-20',
    scheduled_slot: '09:00',
    ...overrides,
  };
}
