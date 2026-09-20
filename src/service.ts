import { randomUUID } from 'node:crypto';
import type { DB } from './db';
import { ApiError } from './errors';
import type { Actor, Row } from './types';

// ---------------------------------------------------------------------------
// 输入类型（与 API 请求体同形，snake_case）
// ---------------------------------------------------------------------------

export interface SubmitMedicationInput {
  student_id: string;
  drug_name: string;
  drug_identity: string;
  expiry_date: string; // YYYY-MM-DD
  storage_condition: string;
  quantity_total: number;
}

export interface SubmitAuthorizationInput {
  written_instruction: string;
  dose_quantity: number;
  schedule_slots: string[];
  valid_from: string;
  valid_until: string;
  emergency_contact_name: string;
  emergency_contact_phone: string;
}

export interface ReceiveInput {
  location: string;
  quantity_counted: number;
  label_conflict_detail?: string; // 药盒标签与线上指示不一致时填写
}

export interface DualCheckInput {
  witness_id: string;
}

export interface HandoverInput {
  from_custodian_id: string;
  to_custodian_id: string;
  to_location: string;
  quantity_counted: number;
  note?: string;
}

export interface ExecuteInput {
  witness_id: string;
  scheduled_date: string; // YYYY-MM-DD
  scheduled_slot: string; // HH:MM
  authorization_id?: string; // 客户端持有的授权版本；与当前确认版本不符时拒绝
  occurred_at?: string; // 离线补传时的实际发生时间
  note?: string;
}

export interface ReturnInput {
  quantity_returned: number;
  note?: string;
}

export interface FreezeInput {
  reason: 'INFO_CONFLICT' | 'PACKAGE_DAMAGED' | 'STORAGE_FAILURE';
  detail: string;
}

export interface DeviationInput {
  type: 'MISSED' | 'REFUSED' | 'DOSE_ERROR';
  detail: string;
  related_event_id?: string;
  scheduled_date?: string;
  scheduled_slot?: string;
  occurred_at?: string;
  client_event_id?: string;
}

export interface BatchItem {
  client_event_id: string;
  kind: 'EXECUTE' | 'DEVIATION';
  medication_id: string;
  occurred_at: string;
  payload: Record<string, any>;
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

const iso = (d: Date) => d.toISOString();

type TxResult<T> = { ok: true; value: T } | { ok: false; error: ApiError };

function getMed(db: DB, id: string): Row {
  const med = db.prepare('SELECT * FROM medications WHERE id = ?').get(id) as Row | undefined;
  if (!med) throw new ApiError(404, 'MEDICATION_NOT_FOUND', '药品不存在');
  return med;
}

function getUser(db: DB, id: string): Row | undefined {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) as Row | undefined;
}

function requireRole(actor: Actor, ...roles: string[]): void {
  if (!roles.includes(actor.role)) {
    throw new ApiError(403, 'FORBIDDEN', `角色 ${actor.role} 无权执行该操作`);
  }
}

function activeFreezes(db: DB, medicationId: string): Row[] {
  return db
    .prepare("SELECT * FROM freezes WHERE medication_id = ? AND status = 'ACTIVE' ORDER BY seq")
    .all(medicationId) as Row[];
}

function assertNotFrozen(db: DB, medicationId: string): void {
  const freezes = activeFreezes(db, medicationId);
  if (freezes.length > 0) {
    throw new ApiError(
      409,
      'MEDICATION_FROZEN',
      `存在未解除的冻结（${freezes[0].reason}），执行已冻结，待负责人处理`,
    );
  }
}

function managerIds(db: DB): string[] {
  return (db.prepare("SELECT id FROM users WHERE role = 'manager'").all() as Row[]).map((r) => r.id);
}

function parentOf(db: DB, medicationId: string): string {
  const row = db
    .prepare(
      `SELECT s.parent_id AS pid FROM medications m
       JOIN students s ON s.id = m.student_id WHERE m.id = ?`,
    )
    .get(medicationId) as Row;
  return row.pid;
}

/** 异常事件的默认通知对象：全体指定负责人 + 该生家长 */
function incidentRecipients(db: DB, medicationId: string): string[] {
  return [...managerIds(db), parentOf(db, medicationId)];
}

function notify(
  db: DB,
  recipientIds: Iterable<string>,
  medicationId: string | null,
  kind: string,
  message: string,
  now: Date,
): void {
  const stmt = db.prepare(
    'INSERT INTO notifications (id, recipient_id, medication_id, kind, message, created_at) VALUES (?,?,?,?,?,?)',
  );
  for (const recipient of new Set(recipientIds)) {
    stmt.run(randomUUID(), recipient, medicationId, kind, message, iso(now));
  }
}

function confirmedAuth(db: DB, medicationId: string): Row | undefined {
  return db
    .prepare("SELECT * FROM authorizations WHERE medication_id = ? AND status = 'CONFIRMED'")
    .get(medicationId) as Row | undefined;
}

/** 建立冻结并通知负责人；同一药品同一原因已有活动冻结时复用，不重复告警 */
function raiseFreeze(
  db: DB,
  medicationId: string,
  reason: string,
  detail: string,
  raisedBy: string,
  now: Date,
): Row {
  const existing = db
    .prepare("SELECT * FROM freezes WHERE medication_id = ? AND reason = ? AND status = 'ACTIVE'")
    .get(medicationId, reason) as Row | undefined;
  if (existing) return existing;
  const id = randomUUID();
  db.prepare(
    'INSERT INTO freezes (id, medication_id, reason, detail, raised_by, created_at) VALUES (?,?,?,?,?,?)',
  ).run(id, medicationId, reason, detail, raisedBy, iso(now));
  notify(db, incidentRecipients(db, medicationId), medicationId, 'FREEZE_RAISED', `药品执行已冻结（${reason}）：${detail}`, now);
  return db.prepare('SELECT * FROM freezes WHERE id = ?').get(id) as Row;
}

interface EventInput {
  medicationId: string;
  type: 'RECEIVE' | 'DUAL_CHECK' | 'HANDOVER' | 'EXECUTE' | 'RETURN';
  actorId: string;
  witnessId?: string | null;
  fromCustodianId?: string | null;
  toCustodianId?: string | null;
  location?: string | null;
  quantityBefore: number;
  quantityAfter: number;
  authorizationId?: string | null;
  scheduledDate?: string | null;
  scheduledSlot?: string | null;
  idempotencyKey: string;
  clientEventId?: string | null;
  occurredAt: string;
  recordedAt: string;
  note?: string | null;
}

function insertEvent(db: DB, e: EventInput): Row {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO custody_events
       (id, medication_id, type, actor_id, witness_id, from_custodian_id, to_custodian_id, location,
        quantity_before, quantity_after, authorization_id, scheduled_date, scheduled_slot,
        idempotency_key, client_event_id, occurred_at, recorded_at, note)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id, e.medicationId, e.type, e.actorId, e.witnessId ?? null,
    e.fromCustodianId ?? null, e.toCustodianId ?? null, e.location ?? null,
    e.quantityBefore, e.quantityAfter, e.authorizationId ?? null,
    e.scheduledDate ?? null, e.scheduledSlot ?? null,
    e.idempotencyKey, e.clientEventId ?? null, e.occurredAt, e.recordedAt, e.note ?? null,
  );
  return db.prepare('SELECT * FROM custody_events WHERE id = ?').get(id) as Row;
}

function findEventByIdempotencyKey(db: DB, key: string): Row | undefined {
  return db.prepare('SELECT * FROM custody_events WHERE idempotency_key = ?').get(key) as Row | undefined;
}

function isUniqueViolation(err: unknown, fragment: string): boolean {
  return err instanceof Error && err.message.includes('UNIQUE constraint failed') && err.message.includes(fragment);
}

/**
 * 保管事件幂等包装：同一 idempotency_key 重复提交（含并发重试）返回首次事件，
 * 不会产生第二次动作。
 */
export function idempotentEvent(
  db: DB,
  key: string,
  fn: () => Row,
): { event: Row; deduplicated: boolean } {
  const existing = findEventByIdempotencyKey(db, key);
  if (existing) return { event: existing, deduplicated: true };
  try {
    return { event: fn(), deduplicated: false };
  } catch (err) {
    if (isUniqueViolation(err, 'custody_events.idempotency_key')) {
      const dup = findEventByIdempotencyKey(db, key);
      if (dup) return { event: dup, deduplicated: true };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// 家长端：提交药品与书面指示
// ---------------------------------------------------------------------------

export function submitMedication(db: DB, actor: Actor, input: SubmitMedicationInput, now: Date): Row {
  requireRole(actor, 'parent');
  const student = db.prepare('SELECT * FROM students WHERE id = ?').get(input.student_id) as Row | undefined;
  if (!student) throw new ApiError(404, 'STUDENT_NOT_FOUND', '学生不存在');
  if (student.parent_id !== actor.id) throw new ApiError(403, 'FORBIDDEN', '只能为本人孩子提交药品');
  const id = randomUUID();
  db.prepare(
    `INSERT INTO medications
       (id, student_id, drug_name, drug_identity, expiry_date, storage_condition,
        quantity_total, quantity_remaining, created_by, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id, input.student_id, input.drug_name, input.drug_identity, input.expiry_date,
    input.storage_condition, input.quantity_total, input.quantity_total, actor.id, iso(now),
  );
  return getMed(db, id);
}

/**
 * 家长提交新版本书面指示。
 * 若当前已存在 CONFIRMED 版本，新旧指示并存构成信息冲突：
 * 自动冻结执行并通知负责人，直到校方确认新版本、负责人解除冻结。
 */
export function submitAuthorization(db: DB, actor: Actor, medicationId: string, input: SubmitAuthorizationInput, now: Date): Row {
  requireRole(actor, 'parent');
  const med = getMed(db, medicationId);
  if (parentOf(db, medicationId) !== actor.id) throw new ApiError(403, 'FORBIDDEN', '只能为本人孩子的药品提交指示');
  if (med.status === 'RETURNED') throw new ApiError(409, 'INVALID_STATE', '药品已退回，不能再提交指示');
  if (!(Date.parse(input.valid_from) <= Date.parse(input.valid_until))) {
    throw new ApiError(400, 'INVALID_WINDOW', '授权有效期起止不合法');
  }
  return db.transaction(() => {
    const row = db.prepare('SELECT MAX(version) AS v FROM authorizations WHERE medication_id = ?').get(medicationId) as Row;
    const version = (row.v ?? 0) + 1;
    const id = randomUUID();
    db.prepare(
      `INSERT INTO authorizations
         (id, medication_id, version, written_instruction, dose_quantity, schedule_slots,
          valid_from, valid_until, emergency_contact_name, emergency_contact_phone, submitted_by, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      id, medicationId, version, input.written_instruction, input.dose_quantity,
      JSON.stringify(input.schedule_slots), input.valid_from, input.valid_until,
      input.emergency_contact_name, input.emergency_contact_phone, actor.id, iso(now),
    );
    let freeze: Row | undefined;
    if (confirmedAuth(db, medicationId)) {
      freeze = raiseFreeze(
        db, medicationId, 'INFO_CONFLICT',
        `家长提交了新的指示版本 v${version}，与现行已确认版本并存，待校方确认`,
        actor.id, now,
      );
    }
    const auth = db.prepare('SELECT * FROM authorizations WHERE id = ?').get(id) as Row;
    return { ...auth, _freeze: freeze ?? null };
  })();
}

/** 校方确认某版本书面指示：确认新版本的同时，旧确认版本自动作废（SUPERSEDED） */
export function confirmAuthorization(db: DB, actor: Actor, authorizationId: string, now: Date): Row {
  requireRole(actor, 'staff', 'manager');
  return db.transaction(() => {
    const auth = db.prepare('SELECT * FROM authorizations WHERE id = ?').get(authorizationId) as Row | undefined;
    if (!auth) throw new ApiError(404, 'AUTH_NOT_FOUND', '指示版本不存在');
    if (auth.status !== 'PENDING') throw new ApiError(409, 'INVALID_STATE', `该版本状态为 ${auth.status}，不能确认`);
    const med = getMed(db, auth.medication_id);
    if (med.status === 'RETURNED') throw new ApiError(409, 'INVALID_STATE', '药品已退回');
    db.prepare("UPDATE authorizations SET status = 'SUPERSEDED' WHERE medication_id = ? AND status = 'CONFIRMED'").run(auth.medication_id);
    db.prepare("UPDATE authorizations SET status = 'CONFIRMED', confirmed_by = ?, confirmed_at = ? WHERE id = ?")
      .run(actor.id, iso(now), authorizationId);
    return db.prepare('SELECT * FROM authorizations WHERE id = ?').get(authorizationId) as Row;
  })();
}

// ---------------------------------------------------------------------------
// 校方：接收 → 双人核对 → 交接 → 执行 → 退回
// ---------------------------------------------------------------------------

/**
 * 接收药品。
 * - 实收数量与家长申报不符：不建立保管记录，直接冻结（INFO_CONFLICT）并通知负责人；
 * - 药盒标签与线上指示不一致：正常入账建立保管责任，同时冻结执行并通知负责人。
 */
export function receiveMedication(
  db: DB, actor: Actor, medicationId: string, input: ReceiveInput, idemKey: string, now: Date,
): { event: Row; freeze: Row | null } {
  requireRole(actor, 'staff');
  const med = getMed(db, medicationId);
  if (med.status !== 'SUBMITTED') throw new ApiError(409, 'INVALID_STATE', `当前状态 ${med.status} 不能接收`);
  if (input.quantity_counted !== med.quantity_total) {
    db.transaction(() => {
      raiseFreeze(db, medicationId, 'INFO_CONFLICT',
        `实收数量 ${input.quantity_counted} 与家长申报 ${med.quantity_total} 不一致`, actor.id, now);
    })();
    throw new ApiError(409, 'QUANTITY_MISMATCH', '实收数量与申报不一致，已冻结并通知负责人');
  }
  return db.transaction(() => {
    const fresh = getMed(db, medicationId);
    if (fresh.status !== 'SUBMITTED') throw new ApiError(409, 'INVALID_STATE', `当前状态 ${fresh.status} 不能接收`);
    const event = insertEvent(db, {
      medicationId, type: 'RECEIVE', actorId: actor.id,
      toCustodianId: actor.id, location: input.location,
      quantityBefore: fresh.quantity_remaining, quantityAfter: fresh.quantity_remaining,
      idempotencyKey: idemKey, occurredAt: iso(now), recordedAt: iso(now),
    });
    db.prepare(
      "UPDATE medications SET status = 'RECEIVED', current_custodian_id = ?, current_location = ?, version = version + 1 WHERE id = ?",
    ).run(actor.id, input.location, medicationId);
    let freeze: Row | null = null;
    if (input.label_conflict_detail) {
      freeze = raiseFreeze(db, medicationId, 'INFO_CONFLICT', input.label_conflict_detail, actor.id, now);
    }
    return { event, freeze };
  })();
}

/** 双人核对：两名不同的校方人员核对药品与书面指示一致后，药品进入保管中状态 */
export function dualCheckMedication(
  db: DB, actor: Actor, medicationId: string, input: DualCheckInput, idemKey: string, now: Date,
): Row {
  requireRole(actor, 'staff');
  return db.transaction(() => {
    const med = getMed(db, medicationId);
    if (med.status !== 'RECEIVED') throw new ApiError(409, 'INVALID_STATE', `当前状态 ${med.status} 不能双人核对`);
    assertNotFrozen(db, medicationId);
    const witness = getUser(db, input.witness_id);
    if (!witness || witness.role !== 'staff') throw new ApiError(400, 'INVALID_WITNESS', '核对人必须是校方人员');
    if (witness.id === actor.id) throw new ApiError(400, 'SAME_PERSON_NOT_ALLOWED', '双人核对要求两名不同的校方人员');
    const event = insertEvent(db, {
      medicationId, type: 'DUAL_CHECK', actorId: actor.id, witnessId: witness.id,
      quantityBefore: med.quantity_remaining, quantityAfter: med.quantity_remaining,
      idempotencyKey: idemKey, occurredAt: iso(now), recordedAt: iso(now),
    });
    db.prepare("UPDATE medications SET status = 'IN_CUSTODY', version = version + 1 WHERE id = ?").run(medicationId);
    return event;
  })();
}

/**
 * 交接（可跨班）。
 * 冻结期间仍允许交接——保管责任必须连续，冻结只阻断执行。
 * 事务内校验当前保管人与清点数量，并发/重复交接只有第一笔能成功。
 */
export function handoverMedication(
  db: DB, actor: Actor, medicationId: string, input: HandoverInput, idemKey: string, now: Date,
): Row {
  requireRole(actor, 'staff');
  return db.transaction(() => {
    const med = getMed(db, medicationId);
    if (med.status !== 'RECEIVED' && med.status !== 'IN_CUSTODY') {
      throw new ApiError(409, 'INVALID_STATE', `当前状态 ${med.status} 不能交接`);
    }
    if (med.current_custodian_id !== input.from_custodian_id) {
      throw new ApiError(409, 'CUSTODY_MISMATCH',
        `账面保管人为 ${med.current_custodian_id ?? '无'}，与交接发起方不一致（可能已被并发交接）`);
    }
    if (input.quantity_counted !== med.quantity_remaining) {
      throw new ApiError(409, 'QUANTITY_MISMATCH',
        `清点数量 ${input.quantity_counted} 与账面剩余 ${med.quantity_remaining} 不一致`);
    }
    const to = getUser(db, input.to_custodian_id);
    if (!to || to.role !== 'staff') throw new ApiError(400, 'INVALID_CUSTODIAN', '接收人必须是校方人员');
    if (to.id === input.from_custodian_id) throw new ApiError(400, 'SAME_PERSON_NOT_ALLOWED', '交接双方不能为同一人');
    const event = insertEvent(db, {
      medicationId, type: 'HANDOVER', actorId: actor.id,
      fromCustodianId: input.from_custodian_id, toCustodianId: to.id, location: input.to_location,
      quantityBefore: med.quantity_remaining, quantityAfter: med.quantity_remaining,
      idempotencyKey: idemKey, occurredAt: iso(now), recordedAt: iso(now), note: input.note ?? null,
    });
    db.prepare('UPDATE medications SET current_custodian_id = ?, current_location = ?, version = version + 1 WHERE id = ?')
      .run(to.id, input.to_location, medicationId);
    return event;
  })();
}

/**
 * 执行给药（核心动作）。
 * 前置条件：保管中、无活动冻结、存在已确认指示且执行时点在授权有效期内、
 * 药品未过有效期、执行人与核对人（双人）为不同校方人员、剩余数量足够、
 * 该时段未执行过。授权/药品过期会自动冻结并通知负责人。
 * 系统只照录与核对书面指示，不做任何诊断或剂量建议。
 */
export function executeMedication(
  db: DB, actor: Actor, medicationId: string, input: ExecuteInput,
  idemKey: string, clientEventId: string | null, now: Date,
): Row {
  requireRole(actor, 'staff');
  const tx = db.transaction((): TxResult<Row> => {
    const med = getMed(db, medicationId);
    if (med.status !== 'IN_CUSTODY') {
      return { ok: false, error: new ApiError(409, 'INVALID_STATE', `当前状态 ${med.status} 不能执行`) };
    }
    const freezes = activeFreezes(db, medicationId);
    if (freezes.length > 0) {
      return { ok: false, error: new ApiError(409, 'MEDICATION_FROZEN', `存在未解除的冻结（${freezes[0].reason}），执行已冻结`) };
    }
    const auth = confirmedAuth(db, medicationId);
    if (!auth) return { ok: false, error: new ApiError(409, 'NO_CONFIRMED_AUTH', '没有已确认的书面指示，不能执行') };
    if (input.authorization_id && input.authorization_id !== auth.id) {
      return { ok: false, error: new ApiError(409, 'AUTH_SUPERSEDED', `指示已变更，当前有效版本为 v${auth.version}，请按最新确认指示执行`) };
    }
    const occurredAt = input.occurred_at ?? iso(now);
    const occurredMs = Date.parse(occurredAt);
    if (Number.isNaN(occurredMs)) return { ok: false, error: new ApiError(400, 'BAD_TIME', 'occurred_at 时间格式不合法') };
    if (occurredMs < Date.parse(auth.valid_from) || occurredMs > Date.parse(auth.valid_until)) {
      raiseFreeze(db, medicationId, 'AUTH_EXPIRED',
        `执行时间 ${occurredAt} 不在授权有效期 ${auth.valid_from} ~ ${auth.valid_until} 内`, actor.id, now);
      return { ok: false, error: new ApiError(409, 'AUTH_EXPIRED', '授权已过期或尚未生效，已冻结并通知负责人') };
    }
    if (occurredAt.slice(0, 10) > med.expiry_date) {
      raiseFreeze(db, medicationId, 'MEDICATION_EXPIRED', `药品有效期至 ${med.expiry_date}，已过期`, actor.id, now);
      return { ok: false, error: new ApiError(409, 'MEDICATION_EXPIRED', '药品已过有效期，已冻结并通知负责人') };
    }
    const witness = getUser(db, input.witness_id);
    if (!witness || witness.role !== 'staff') return { ok: false, error: new ApiError(400, 'INVALID_WITNESS', '核对人必须是校方人员') };
    if (witness.id === actor.id) return { ok: false, error: new ApiError(400, 'SAME_PERSON_NOT_ALLOWED', '执行人与核对人不能为同一人') };
    const dose = auth.dose_quantity as number;
    if (med.quantity_remaining < dose) {
      return { ok: false, error: new ApiError(409, 'INSUFFICIENT_QUANTITY', `剩余数量 ${med.quantity_remaining} 不足本次用量 ${dose}`) };
    }
    const dupSlot = db.prepare(
      "SELECT id FROM custody_events WHERE type = 'EXECUTE' AND medication_id = ? AND scheduled_date = ? AND scheduled_slot = ?",
    ).get(medicationId, input.scheduled_date, input.scheduled_slot);
    if (dupSlot) {
      return { ok: false, error: new ApiError(409, 'SLOT_ALREADY_EXECUTED', '该时段已执行过，重复扫码不会形成第二次动作') };
    }
    const event = insertEvent(db, {
      medicationId, type: 'EXECUTE', actorId: actor.id, witnessId: witness.id,
      quantityBefore: med.quantity_remaining, quantityAfter: med.quantity_remaining - dose,
      authorizationId: auth.id, scheduledDate: input.scheduled_date, scheduledSlot: input.scheduled_slot,
      idempotencyKey: idemKey, clientEventId, occurredAt, recordedAt: iso(now), note: input.note ?? null,
    });
    db.prepare('UPDATE medications SET quantity_remaining = quantity_remaining - ?, version = version + 1 WHERE id = ?')
      .run(dose, medicationId);
    notify(db, [parentOf(db, medicationId)], medicationId, 'EXECUTION_CONFIRMED',
      `已按 v${auth.version} 书面指示执行 ${input.scheduled_date} ${input.scheduled_slot}，剩余数量 ${med.quantity_remaining - dose}`, now);
    return { ok: true, value: event };
  });
  const result = tx();
  if (!result.ok) throw result.error;
  return result.value;
}

/** 退回家长：剩余数量全部退回，保管责任终止 */
export function returnMedication(
  db: DB, actor: Actor, medicationId: string, input: ReturnInput, idemKey: string, now: Date,
): Row {
  requireRole(actor, 'staff');
  return db.transaction(() => {
    const med = getMed(db, medicationId);
    if (med.status !== 'RECEIVED' && med.status !== 'IN_CUSTODY') {
      throw new ApiError(409, 'INVALID_STATE', `当前状态 ${med.status} 不能退回`);
    }
    if (input.quantity_returned !== med.quantity_remaining) {
      throw new ApiError(409, 'QUANTITY_MISMATCH', `退回数量 ${input.quantity_returned} 与账面剩余 ${med.quantity_remaining} 不一致`);
    }
    const event = insertEvent(db, {
      medicationId, type: 'RETURN', actorId: actor.id,
      fromCustodianId: med.current_custodian_id,
      quantityBefore: med.quantity_remaining, quantityAfter: 0,
      idempotencyKey: idemKey, occurredAt: iso(now), recordedAt: iso(now), note: input.note ?? null,
    });
    db.prepare(
      "UPDATE medications SET status = 'RETURNED', quantity_remaining = 0, current_custodian_id = NULL, current_location = NULL, version = version + 1 WHERE id = ?",
    ).run(medicationId);
    notify(db, [parentOf(db, medicationId)], medicationId, 'MEDICATION_RETURNED',
      `药品已退回家长，退回数量 ${input.quantity_returned}`, now);
    return event;
  })();
}

// ---------------------------------------------------------------------------
// 冻结与差错
// ---------------------------------------------------------------------------

/** 校方人工上报异常（包装破损 / 保管条件失效 / 发现信息冲突）→ 冻结并通知负责人 */
export function reportFreeze(db: DB, actor: Actor, medicationId: string, input: FreezeInput, now: Date): Row {
  requireRole(actor, 'staff', 'manager');
  getMed(db, medicationId);
  return db.transaction(() => raiseFreeze(db, medicationId, input.reason, input.detail, actor.id, now))();
}

/** 负责人解除冻结（必须留下处理说明） */
export function resolveFreeze(db: DB, actor: Actor, freezeId: string, resolutionNote: string, now: Date): Row {
  requireRole(actor, 'manager');
  return db.transaction(() => {
    const freeze = db.prepare('SELECT * FROM freezes WHERE id = ?').get(freezeId) as Row | undefined;
    if (!freeze) throw new ApiError(404, 'FREEZE_NOT_FOUND', '冻结记录不存在');
    if (freeze.status !== 'ACTIVE') throw new ApiError(409, 'INVALID_STATE', '该冻结已解除');
    db.prepare("UPDATE freezes SET status = 'RESOLVED', resolved_by = ?, resolved_at = ?, resolution_note = ? WHERE id = ?")
      .run(actor.id, iso(now), resolutionNote, freezeId);
    notify(db, [parentOf(db, freeze.medication_id)], freeze.medication_id, 'FREEZE_RESOLVED',
      `冻结（${freeze.reason}）已解除：${resolutionNote}`, now);
    return db.prepare('SELECT * FROM freezes WHERE id = ?').get(freezeId) as Row;
  })();
}

/**
 * 差错事件（漏执行 / 学生拒绝 / 用量误差）：只追加，绝不修改原执行记录。
 * DOSE_ERROR 必须关联一笔本药品的 EXECUTE 事件。
 */
export function reportDeviation(
  db: DB, actor: Actor, medicationId: string, input: DeviationInput, now: Date,
): { deviation: Row; deduplicated: boolean } {
  requireRole(actor, 'staff');
  getMed(db, medicationId);
  if (input.client_event_id) {
    const dup = db.prepare('SELECT * FROM deviations WHERE client_event_id = ?').get(input.client_event_id) as Row | undefined;
    if (dup) return { deviation: dup, deduplicated: true };
  }
  return db.transaction(() => {
    if (input.type === 'DOSE_ERROR') {
      if (!input.related_event_id) throw new ApiError(400, 'RELATED_EVENT_REQUIRED', '用量误差必须关联原执行记录');
      const ev = db.prepare(
        "SELECT id FROM custody_events WHERE id = ? AND medication_id = ? AND type = 'EXECUTE'",
      ).get(input.related_event_id, medicationId);
      if (!ev) throw new ApiError(400, 'INVALID_RELATED_EVENT', '关联的执行记录不存在');
    }
    const id = randomUUID();
    const occurredAt = input.occurred_at ?? iso(now);
    try {
      db.prepare(
        `INSERT INTO deviations
           (id, medication_id, type, related_event_id, scheduled_date, scheduled_slot,
            detail, reported_by, client_event_id, occurred_at, recorded_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        id, medicationId, input.type, input.related_event_id ?? null,
        input.scheduled_date ?? null, input.scheduled_slot ?? null,
        input.detail, actor.id, input.client_event_id ?? null, occurredAt, iso(now),
      );
    } catch (err) {
      if (input.client_event_id && isUniqueViolation(err, 'deviations.client_event_id')) {
        const dup = db.prepare('SELECT * FROM deviations WHERE client_event_id = ?').get(input.client_event_id) as Row;
        return { deviation: dup, deduplicated: true };
      }
      throw err;
    }
    notify(db, incidentRecipients(db, medicationId), medicationId, 'DEVIATION_REPORTED',
      `差错事件（${input.type}）：${input.detail}`, now);
    return { deviation: db.prepare('SELECT * FROM deviations WHERE id = ?').get(id) as Row, deduplicated: false };
  })();
}

// ---------------------------------------------------------------------------
// 离线补传
// ---------------------------------------------------------------------------

/**
 * 离线补传：客户端离线期间产生的事件（携带离线时生成的 client_event_id 与实际
 * 发生时间 occurred_at）批量上传。每条独立事务处理，互不影响；重传整批时
 * 已入账事件返回 duplicate，不会产生第二次动作。
 */
export function syncBatch(db: DB, actor: Actor, items: BatchItem[], now: Date): { results: Row[] } {
  requireRole(actor, 'staff');
  const results: Row[] = [];
  for (const item of items) {
    try {
      if (!item.client_event_id) throw new ApiError(400, 'CLIENT_EVENT_ID_REQUIRED', '离线事件必须携带客户端事件ID');
      const dupEvent = db.prepare('SELECT id FROM custody_events WHERE client_event_id = ?').get(item.client_event_id);
      const dupDeviation = db.prepare('SELECT id FROM deviations WHERE client_event_id = ?').get(item.client_event_id);
      if (dupEvent || dupDeviation) {
        results.push({ client_event_id: item.client_event_id, status: 'duplicate' });
        continue;
      }
      if (item.kind === 'EXECUTE') {
        const p = item.payload;
        const event = executeMedication(db, actor, item.medication_id, {
          witness_id: p.witness_id,
          scheduled_date: p.scheduled_date,
          scheduled_slot: p.scheduled_slot,
          authorization_id: p.authorization_id,
          occurred_at: item.occurred_at,
          note: p.note,
        }, `batch:${item.client_event_id}`, item.client_event_id, now);
        results.push({ client_event_id: item.client_event_id, status: 'applied', event_id: event.id });
      } else if (item.kind === 'DEVIATION') {
        const p = item.payload;
        const { deviation } = reportDeviation(db, actor, item.medication_id, {
          type: p.type, detail: p.detail, related_event_id: p.related_event_id,
          scheduled_date: p.scheduled_date, scheduled_slot: p.scheduled_slot,
          occurred_at: item.occurred_at, client_event_id: item.client_event_id,
        }, now);
        results.push({ client_event_id: item.client_event_id, status: 'applied', deviation_id: deviation.id });
      } else {
        throw new ApiError(400, 'UNKNOWN_KIND', `不支持的事件类型 ${String(item.kind)}`);
      }
    } catch (err) {
      if (err instanceof ApiError) {
        results.push({ client_event_id: item.client_event_id, status: 'rejected', code: err.code, message: err.message });
      } else {
        throw err;
      }
    }
  }
  return { results };
}

// ---------------------------------------------------------------------------
// 查询：家长端 / 负责人 / 审计
// ---------------------------------------------------------------------------

function serializeAuth(auth: Row): Row {
  return { ...auth, schedule_slots: JSON.parse(auth.schedule_slots) };
}

function userName(db: DB, id: string | null): string | null {
  if (!id) return null;
  const u = getUser(db, id);
  return u ? u.name : null;
}

function serializeEvent(db: DB, event: Row): Row {
  return {
    ...event,
    actor_name: userName(db, event.actor_id),
    witness_name: userName(db, event.witness_id),
    from_custodian_name: userName(db, event.from_custodian_id),
    to_custodian_name: userName(db, event.to_custodian_id),
  };
}

function medicationView(db: DB, med: Row): Row {
  const auth = confirmedAuth(db, med.id);
  return {
    ...med,
    current_custodian_name: userName(db, med.current_custodian_id),
    confirmed_authorization: auth ? serializeAuth(auth) : null,
    active_freezes: activeFreezes(db, med.id),
  };
}

/** 家长端：本人孩子的药品状态、最近执行确认、差错与异常通知 */
export function parentStudentStatus(db: DB, actor: Actor, studentId: string): Row {
  requireRole(actor, 'parent');
  const student = db.prepare('SELECT * FROM students WHERE id = ?').get(studentId) as Row | undefined;
  if (!student) throw new ApiError(404, 'STUDENT_NOT_FOUND', '学生不存在');
  if (student.parent_id !== actor.id) throw new ApiError(403, 'FORBIDDEN', '只能查看本人孩子的信息');
  const medications = (db.prepare('SELECT * FROM medications WHERE student_id = ? ORDER BY created_at').all(studentId) as Row[])
    .map((med) => ({
      ...medicationView(db, med),
      recent_executions: (db.prepare(
        "SELECT * FROM custody_events WHERE medication_id = ? AND type = 'EXECUTE' ORDER BY seq DESC LIMIT 5",
      ).all(med.id) as Row[]).map((e) => serializeEvent(db, e)),
      deviations: db.prepare('SELECT * FROM deviations WHERE medication_id = ? ORDER BY seq DESC').all(med.id) as Row[],
    }));
  const notifications = db.prepare(
    'SELECT * FROM notifications WHERE recipient_id = ? ORDER BY seq DESC LIMIT 50',
  ).all(actor.id) as Row[];
  return { student, medications, notifications };
}

export function listNotifications(db: DB, actor: Actor): Row[] {
  return db.prepare('SELECT * FROM notifications WHERE recipient_id = ? ORDER BY seq DESC LIMIT 100').all(actor.id) as Row[];
}

export function getMedicationView(db: DB, actor: Actor, medicationId: string): Row {
  const med = getMed(db, medicationId);
  if (actor.role === 'parent' && parentOf(db, medicationId) !== actor.id) {
    throw new ApiError(403, 'FORBIDDEN', '只能查看本人孩子的药品');
  }
  return medicationView(db, med);
}

/** 学校审计视图：从药品维度看完整链路（授权版本、双人核对、交接链、执行、差错、冻结） */
export function auditTrace(db: DB, actor: Actor, medicationId: string): Row {
  requireRole(actor, 'auditor', 'manager');
  const med = getMed(db, medicationId);
  const student = db.prepare('SELECT * FROM students WHERE id = ?').get(med.student_id) as Row;
  const authorizations = (db.prepare(
    'SELECT * FROM authorizations WHERE medication_id = ? ORDER BY version',
  ).all(medicationId) as Row[]).map(serializeAuth);
  const custodyChain = (db.prepare(
    'SELECT * FROM custody_events WHERE medication_id = ? ORDER BY seq',
  ).all(medicationId) as Row[]).map((e) => serializeEvent(db, e));
  const freezes = db.prepare('SELECT * FROM freezes WHERE medication_id = ? ORDER BY seq').all(medicationId) as Row[];
  const deviations = db.prepare('SELECT * FROM deviations WHERE medication_id = ? ORDER BY seq').all(medicationId) as Row[];
  return {
    medication: medicationView(db, med),
    student,
    authorizations,
    custody_chain: custodyChain,
    freezes,
    deviations,
    quantity_remaining: med.quantity_remaining,
  };
}

/** 学校审计视图：从一次执行追到授权版本、核对人员、交接链与剩余数量 */
export function auditExecution(db: DB, actor: Actor, eventId: string): Row {
  requireRole(actor, 'auditor', 'manager');
  const event = db.prepare("SELECT * FROM custody_events WHERE id = ? AND type = 'EXECUTE'").get(eventId) as Row | undefined;
  if (!event) throw new ApiError(404, 'EXECUTION_NOT_FOUND', '执行记录不存在');
  const med = getMed(db, event.medication_id);
  const auth = event.authorization_id
    ? (db.prepare('SELECT * FROM authorizations WHERE id = ?').get(event.authorization_id) as Row)
    : null;
  const handoverChain = (db.prepare(
    "SELECT * FROM custody_events WHERE medication_id = ? AND type = 'HANDOVER' AND seq <= ? ORDER BY seq",
  ).all(event.medication_id, event.seq) as Row[]).map((e) => serializeEvent(db, e));
  const deviations = db.prepare('SELECT * FROM deviations WHERE related_event_id = ? ORDER BY seq').all(eventId) as Row[];
  return {
    execution: serializeEvent(db, event),
    authorization: auth ? serializeAuth(auth) : null,
    handover_chain: handoverChain,
    deviations,
    quantity_after: event.quantity_after,
    quantity_remaining_now: med.quantity_remaining,
  };
}
