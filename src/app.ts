import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import type { DB } from './db';
import { ApiError } from './errors';
import * as svc from './service';
import type { Actor } from './types';

declare module 'fastify' {
  interface FastifyRequest {
    actor: Actor;
  }
}

export interface AppOptions {
  db: DB;
  now?: () => Date; // 可注入时钟，便于测试授权到期等场景
}

const idParam = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string' } },
} as const;

const body = {
  submitMedication: {
    type: 'object',
    required: ['student_id', 'drug_name', 'drug_identity', 'expiry_date', 'storage_condition', 'quantity_total'],
    additionalProperties: false,
    properties: {
      student_id: { type: 'string' },
      drug_name: { type: 'string', minLength: 1 },
      drug_identity: { type: 'string', minLength: 1 },
      expiry_date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      storage_condition: { type: 'string', minLength: 1 },
      quantity_total: { type: 'integer', minimum: 1 },
    },
  },
  submitAuthorization: {
    type: 'object',
    required: ['written_instruction', 'dose_quantity', 'schedule_slots', 'valid_from', 'valid_until',
      'emergency_contact_name', 'emergency_contact_phone'],
    additionalProperties: false,
    properties: {
      written_instruction: { type: 'string', minLength: 1 },
      dose_quantity: { type: 'integer', minimum: 1 },
      schedule_slots: { type: 'array', minItems: 1, items: { type: 'string', pattern: '^\\d{2}:\\d{2}$' } },
      valid_from: { type: 'string', minLength: 4 },
      valid_until: { type: 'string', minLength: 4 },
      emergency_contact_name: { type: 'string', minLength: 1 },
      emergency_contact_phone: { type: 'string', minLength: 1 },
    },
  },
  receive: {
    type: 'object',
    required: ['location', 'quantity_counted'],
    additionalProperties: false,
    properties: {
      location: { type: 'string', minLength: 1 },
      quantity_counted: { type: 'integer', minimum: 0 },
      label_conflict_detail: { type: 'string', minLength: 1 },
    },
  },
  dualCheck: {
    type: 'object',
    required: ['witness_id'],
    additionalProperties: false,
    properties: { witness_id: { type: 'string' } },
  },
  handover: {
    type: 'object',
    required: ['from_custodian_id', 'to_custodian_id', 'to_location', 'quantity_counted'],
    additionalProperties: false,
    properties: {
      from_custodian_id: { type: 'string' },
      to_custodian_id: { type: 'string' },
      to_location: { type: 'string', minLength: 1 },
      quantity_counted: { type: 'integer', minimum: 0 },
      note: { type: 'string' },
    },
  },
  execute: {
    type: 'object',
    required: ['witness_id', 'scheduled_date', 'scheduled_slot'],
    additionalProperties: false,
    properties: {
      witness_id: { type: 'string' },
      scheduled_date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      scheduled_slot: { type: 'string', pattern: '^\\d{2}:\\d{2}$' },
      authorization_id: { type: 'string' },
      occurred_at: { type: 'string' },
      note: { type: 'string' },
    },
  },
  returnMed: {
    type: 'object',
    required: ['quantity_returned'],
    additionalProperties: false,
    properties: {
      quantity_returned: { type: 'integer', minimum: 0 },
      note: { type: 'string' },
    },
  },
  freeze: {
    type: 'object',
    required: ['reason', 'detail'],
    additionalProperties: false,
    properties: {
      reason: { type: 'string', enum: ['INFO_CONFLICT', 'PACKAGE_DAMAGED', 'STORAGE_FAILURE'] },
      detail: { type: 'string', minLength: 1 },
    },
  },
  resolveFreeze: {
    type: 'object',
    required: ['resolution_note'],
    additionalProperties: false,
    properties: { resolution_note: { type: 'string', minLength: 1 } },
  },
  deviation: {
    type: 'object',
    required: ['type', 'detail'],
    additionalProperties: false,
    properties: {
      type: { type: 'string', enum: ['MISSED', 'REFUSED', 'DOSE_ERROR'] },
      detail: { type: 'string', minLength: 1 },
      related_event_id: { type: 'string' },
      scheduled_date: { type: 'string' },
      scheduled_slot: { type: 'string' },
      occurred_at: { type: 'string' },
      client_event_id: { type: 'string' },
    },
  },
  batch: {
    type: 'object',
    required: ['events'],
    additionalProperties: false,
    properties: {
      events: {
        type: 'array',
        minItems: 1,
        maxItems: 200,
        items: {
          type: 'object',
          required: ['client_event_id', 'kind', 'medication_id', 'occurred_at', 'payload'],
          properties: {
            client_event_id: { type: 'string', minLength: 1 },
            kind: { type: 'string', enum: ['EXECUTE', 'DEVIATION'] },
            medication_id: { type: 'string' },
            occurred_at: { type: 'string' },
            payload: { type: 'object' },
          },
        },
      },
    },
  },
} as const;

function idempotencyKey(req: FastifyRequest): string {
  const key = req.headers['idempotency-key'];
  if (typeof key !== 'string' || key.length === 0) {
    throw new ApiError(400, 'IDEMPOTENCY_KEY_REQUIRED', '缺少 idempotency-key 请求头');
  }
  return key;
}

export function buildApp(opts: AppOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  const db = opts.db;
  const now = () => (opts.now ? opts.now() : new Date());

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError) {
      return reply.status(err.status).send({ error: { code: err.code, message: err.message } });
    }
    const anyErr = err as { statusCode?: number; code?: string; message?: string };
    if (anyErr.statusCode === 400) {
      return reply.status(400).send({ error: { code: 'BAD_REQUEST', message: anyErr.message ?? '请求不合法' } });
    }
    if (typeof anyErr.code === 'string' && anyErr.code.startsWith('SQLITE_CONSTRAINT')) {
      return reply.status(409).send({ error: { code: 'CONSTRAINT_VIOLATION', message: anyErr.message ?? '约束冲突' } });
    }
    req.log.error(err);
    return reply.status(500).send({ error: { code: 'INTERNAL', message: '服务器内部错误' } });
  });

  // 简易身份认证：x-actor-id 请求头对应 users 表（健康检查除外）
  app.addHook('onRequest', async (req) => {
    if (req.url === '/api/health') return;
    const id = req.headers['x-actor-id'];
    if (typeof id !== 'string' || id.length === 0) {
      throw new ApiError(401, 'UNAUTHENTICATED', '缺少 x-actor-id 请求头');
    }
    const user = db.prepare('SELECT id, name, role FROM users WHERE id = ?').get(id) as Actor | undefined;
    if (!user) throw new ApiError(401, 'UNAUTHENTICATED', '未知用户');
    req.actor = user;
  });

  app.get('/api/health', async () => ({ ok: true }));

  // ---- 家长端 ----
  app.post('/api/medications', { schema: { body: body.submitMedication } }, async (req, reply) => {
    const med = svc.submitMedication(db, req.actor, req.body as svc.SubmitMedicationInput, now());
    return reply.status(201).send(med);
  });

  app.post('/api/medications/:id/authorizations', { schema: { body: body.submitAuthorization, params: idParam } }, async (req, reply) => {
    const auth = svc.submitAuthorization(db, req.actor, (req.params as { id: string }).id, req.body as svc.SubmitAuthorizationInput, now());
    return reply.status(201).send(auth);
  });

  app.get('/api/parent/students/:id/status', { schema: { params: idParam } }, async (req) => {
    return svc.parentStudentStatus(db, req.actor, (req.params as { id: string }).id);
  });

  // ---- 校方：指示确认与保管动作 ----
  app.post('/api/authorizations/:id/confirm', { schema: { params: idParam } }, async (req) => {
    return svc.confirmAuthorization(db, req.actor, (req.params as { id: string }).id, now());
  });

  app.post('/api/medications/:id/receive', { schema: { body: body.receive, params: idParam } }, async (req, reply) => {
    const key = idempotencyKey(req);
    const medId = (req.params as { id: string }).id;
    const result = svc.idempotentEvent(db, key, () =>
      svc.receiveMedication(db, req.actor, medId, req.body as svc.ReceiveInput, key, now()).event);
    const extra = svc.getMedicationView(db, req.actor, medId);
    return reply.status(result.deduplicated ? 200 : 201).send({ ...result, medication: extra });
  });

  app.post('/api/medications/:id/dual-check', { schema: { body: body.dualCheck, params: idParam } }, async (req, reply) => {
    const key = idempotencyKey(req);
    const result = svc.idempotentEvent(db, key, () =>
      svc.dualCheckMedication(db, req.actor, (req.params as { id: string }).id, req.body as svc.DualCheckInput, key, now()));
    return reply.status(result.deduplicated ? 200 : 201).send(result);
  });

  app.post('/api/medications/:id/handover', { schema: { body: body.handover, params: idParam } }, async (req, reply) => {
    const key = idempotencyKey(req);
    const result = svc.idempotentEvent(db, key, () =>
      svc.handoverMedication(db, req.actor, (req.params as { id: string }).id, req.body as svc.HandoverInput, key, now()));
    return reply.status(result.deduplicated ? 200 : 201).send(result);
  });

  app.post('/api/medications/:id/execute', { schema: { body: body.execute, params: idParam } }, async (req, reply) => {
    const key = idempotencyKey(req);
    const result = svc.idempotentEvent(db, key, () =>
      svc.executeMedication(db, req.actor, (req.params as { id: string }).id, req.body as svc.ExecuteInput, key, null, now()));
    return reply.status(result.deduplicated ? 200 : 201).send(result);
  });

  app.post('/api/medications/:id/return', { schema: { body: body.returnMed, params: idParam } }, async (req, reply) => {
    const key = idempotencyKey(req);
    const result = svc.idempotentEvent(db, key, () =>
      svc.returnMedication(db, req.actor, (req.params as { id: string }).id, req.body as svc.ReturnInput, key, now()));
    return reply.status(result.deduplicated ? 200 : 201).send(result);
  });

  // ---- 冻结与差错 ----
  app.post('/api/medications/:id/freezes', { schema: { body: body.freeze, params: idParam } }, async (req, reply) => {
    const freeze = svc.reportFreeze(db, req.actor, (req.params as { id: string }).id, req.body as svc.FreezeInput, now());
    return reply.status(201).send(freeze);
  });

  app.post('/api/freezes/:id/resolve', { schema: { body: body.resolveFreeze, params: idParam } }, async (req) => {
    return svc.resolveFreeze(db, req.actor, (req.params as { id: string }).id, (req.body as { resolution_note: string }).resolution_note, now());
  });

  app.post('/api/medications/:id/deviations', { schema: { body: body.deviation, params: idParam } }, async (req, reply) => {
    const result = svc.reportDeviation(db, req.actor, (req.params as { id: string }).id, req.body as svc.DeviationInput, now());
    return reply.status(result.deduplicated ? 200 : 201).send(result);
  });

  // ---- 离线补传 ----
  app.post('/api/events/batch', { schema: { body: body.batch } }, async (req) => {
    return svc.syncBatch(db, req.actor, (req.body as { events: svc.BatchItem[] }).events, now());
  });

  // ---- 查询 ----
  app.get('/api/medications/:id', { schema: { params: idParam } }, async (req) => {
    return svc.getMedicationView(db, req.actor, (req.params as { id: string }).id);
  });

  app.get('/api/notifications', async (req) => {
    return { notifications: svc.listNotifications(db, req.actor) };
  });

  app.get('/api/audit/medications/:id/trace', { schema: { params: idParam } }, async (req) => {
    return svc.auditTrace(db, req.actor, (req.params as { id: string }).id);
  });

  app.get('/api/audit/executions/:id', { schema: { params: idParam } }, async (req) => {
    return svc.auditExecution(db, req.actor, (req.params as { id: string }).id);
  });

  return app;
}
