import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { IdempotentReplay, type MedicationService } from '../services/medicationService.js';
import { DomainError } from '../errors.js';
import type { WrittenInstruction } from '../domain/types.js';

type AuthContext =
  | { kind: 'staff'; id: string; name: string; role: string; responsible: boolean }
  | { kind: 'guardian'; id: string; name: string };

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

/** 从 Bearer token 解析调用方身份。 */
function authenticate(service: MedicationService) {
  return async (req: FastifyRequest) => {
    if (req.url.startsWith('/admin/') || req.url === '/health') return; // 初始化与健康检查不鉴权
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw DomainError.unauthorized('缺少 Bearer token');
    req.auth = service.authenticateToken(header.slice(7));
  };
}

function requireStaff(req: FastifyRequest, responsible = false): Extract<AuthContext, { kind: 'staff' }> {
  if (!req.auth || req.auth.kind !== 'staff') throw DomainError.forbidden('仅校方人员可操作');
  if (responsible && !req.auth.responsible) throw DomainError.forbidden('需要指定负责人权限');
  return req.auth;
}

function requireGuardian(req: FastifyRequest): Extract<AuthContext, { kind: 'guardian' }> {
  if (!req.auth || req.auth.kind !== 'guardian') throw DomainError.forbidden('仅家长可操作');
  return req.auth;
}

/** 从 X-Idempotency-Key / 客户端字段构造扫码幂等键。 */
function idempotency(req: FastifyRequest, body: Record<string, unknown> | undefined) {
  const headerKey = req.headers['x-idempotency-key'];
  const key = typeof headerKey === 'string' && headerKey
    ? headerKey
    : typeof body?.clientEventId === 'string'
      ? `${String(body?.deviceId ?? 'device')}:${body.clientEventId}`
      : undefined;
  if (!key) return undefined;
  return { key, deviceId: typeof body?.deviceId === 'string' ? body.deviceId : undefined };
}

export async function registerRoutes(app: FastifyInstance, service: MedicationService): Promise<void> {
  app.addHook('preHandler', authenticate(service));

  app.setErrorHandler((err, _req, reply: FastifyReply) => {
    if (err instanceof IdempotentReplay) {
      return reply.status(200).send({ replayed: true, result: err.payload });
    }
    if (err instanceof DomainError) {
      return reply.status(err.statusCode).send({ error: err.code, message: err.message, details: err.details });
    }
    reqLog(_req, err as Error);
    return reply.status(500).send({ error: 'internal_error', message: '服务器内部错误' });
  });

  /* ===== 基础数据（演示/初始化用，preHandler 中跳过鉴权） ===== */

  app.post('/admin/guardians', async (req) => {
    const b = req.body as { name: string; phone: string; emergencyPhone: string; emergencyNote?: string };
    return service.createGuardian(b);
  });

  app.post('/admin/students', async (req) => {
    const b = req.body as { guardianId: string; name: string };
    return service.createStudent(b.guardianId, b.name);
  });

  app.post('/admin/staff', async (req) => {
    const b = req.body as { name: string; role: 'teacher' | 'nurse' | 'coordinator'; responsible?: boolean };
    return service.createStaff(b);
  });

  /* ----- 家长端 ----- */

  // 家长登记药品（药品身份、有效期、保管条件、书面指示）
  app.post('/guardian/medications', async (req) => {
    const g = requireGuardian(req);
    const b = req.body as Record<string, unknown>;
    return service.registerMedication({
      guardianId: g.id,
      studentId: String(b.studentId),
      packageCode: String(b.packageCode),
      labelDrugName: String(b.labelDrugName),
      labelDoseText: String(b.labelDoseText),
      labelManufacturer: b.labelManufacturer ? String(b.labelManufacturer) : undefined,
      expiryDate: String(b.expiryDate),
      storageRequirement: b.storageRequirement as 'room_temp' | 'refrigerated' | 'cool_dark',
      initialQuantity: Number(b.initialQuantity),
      quantityUnit: String(b.quantityUnit),
      packageDamaged: Boolean(b.packageDamaged),
      instruction: b.instruction as WrittenInstruction,
    });
  });

  // 家长提交书面指示变更（新版本，冻结至重新双人核对）
  app.post('/guardian/medications/:medId/instruction-versions', async (req) => {
    const g = requireGuardian(req);
    const { medId } = req.params as { medId: string };
    const b = req.body as Record<string, unknown>;
    return service.submitInstructionChange(g.id, medId, b.instruction);
  });

  // 家长视图：本人孩子的确认状态与异常通知
  app.get('/guardian/view', async (req) => {
    const g = requireGuardian(req);
    return { students: service.guardianView(g.id) };
  });

  app.get('/guardian/notifications', async (req) => {
    const g = requireGuardian(req);
    return { notifications: service.listNotifications('guardian', g.id) };
  });

  /* ----- 校方端 ----- */

  // 接收（扫码；重复扫码不产生第二次接收）
  app.post('/staff/medications/:medId/receive', async (req) => {
    const s = requireStaff(req);
    const { medId } = req.params as { medId: string };
    const b = (req.body ?? {}) as Record<string, unknown>;
    return service.receive(
      s.id,
      medId,
      { packageIntact: Boolean(b.packageIntact), storageMet: Boolean(b.storageMet), note: b.note ? String(b.note) : undefined },
      idempotency(req, b),
    );
  });

  // 双人核对（两名不同人员）
  app.post('/staff/medications/:medId/verify', async (req) => {
    const s = requireStaff(req);
    const { medId } = req.params as { medId: string };
    const b = req.body as Record<string, unknown>;
    return service.verify(
      s.id,
      medId,
      {
        authId: b.authId ? String(b.authId) : undefined,
        staff1Id: String(b.staff1Id),
        staff2Id: String(b.staff2Id),
        storageMet: Boolean(b.storageMet),
        note: b.note ? String(b.note) : undefined,
      },
      idempotency(req, b),
    );
  });

  // 跨班交接（数量一致、保管人变更）
  app.post('/staff/medications/:medId/handoff', async (req) => {
    const s = requireStaff(req);
    const { medId } = req.params as { medId: string };
    const b = req.body as Record<string, unknown>;
    return service.handoff(
      s.id,
      medId,
      { toStaffId: String(b.toStaffId), quantity: Number(b.quantity), note: b.note ? String(b.note) : undefined },
      idempotency(req, b),
    );
  });

  // 实际执行（一经确认不可删除；同一时点重复领取被拒绝）
  app.post('/staff/medications/:medId/execute', async (req) => {
    const s = requireStaff(req);
    const { medId } = req.params as { medId: string };
    const b = req.body as Record<string, unknown>;
    return service.execute(
      s.id,
      medId,
      {
        scheduledDate: b.scheduledDate ? String(b.scheduledDate) : undefined,
        scheduledTime: String(b.scheduledTime),
        administeredQty: Number(b.administeredQty),
        occurredAt: b.occurredAt ? String(b.occurredAt) : undefined,
      },
      idempotency(req, b),
    );
  });

  // 追加差错事件（漏执行/学生拒绝/误差），不修改执行记录
  app.post('/staff/medications/:medId/incidents', async (req) => {
    const s = requireStaff(req);
    const { medId } = req.params as { medId: string };
    const b = req.body as Record<string, unknown>;
    return service.reportIncident(
      s.id,
      medId,
      {
        type: b.type as never,
        detail: b.detail ? String(b.detail) : undefined,
        scheduledDate: b.scheduledDate ? String(b.scheduledDate) : undefined,
        scheduledTime: b.scheduledTime ? String(b.scheduledTime) : undefined,
        occurredAt: b.occurredAt ? String(b.occurredAt) : undefined,
      },
      idempotency(req, b),
    );
  });

  // 退回家长
  app.post('/staff/medications/:medId/return', async (req) => {
    const s = requireStaff(req);
    const { medId } = req.params as { medId: string };
    const b = (req.body ?? {}) as Record<string, unknown>;
    return service.returnMedication(s.id, medId, { note: b.note ? String(b.note) : undefined }, idempotency(req, b));
  });

  // 离线补传：执行/差错事件批量上报（每条独立幂等键）
  app.post('/staff/medications/:medId/backfill', async (req) => {
    const s = requireStaff(req);
    const { medId } = req.params as { medId: string };
    const b = req.body as { events: unknown[] };
    return service.backfill(s.id, medId, b.events);
  });

  // 负责人通知
  app.get('/staff/notifications', async (req) => {
    requireStaff(req, true);
    return { notifications: service.listNotifications('responsible') };
  });

  // 学校审计视图
  app.get('/staff/medications/:medId/audit', async (req) => {
    requireStaff(req);
    const { medId } = req.params as { medId: string };
    return service.auditView(medId);
  });

  // 从一次执行追到授权版本、核对人员、交接链、剩余数量
  app.get('/staff/executions/:executionId/trace', async (req) => {
    requireStaff(req);
    const { executionId } = req.params as { executionId: string };
    return service.executionTrace(executionId);
  });

  // 手动触发授权到期巡检（也可由定时器调用）
  app.post('/staff/sweep-expirations', async (req) => {
    requireStaff(req, true);
    return service.sweepExpirations();
  });
}

function reqLog(req: FastifyRequest, err: Error): void {
  req.log.error({ err: err.message, path: req.url }, 'request failed');
}
