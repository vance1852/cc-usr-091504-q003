import type { DB } from '../db.js';
import { newId } from '../ids.js';
import { DomainError } from '../errors.js';
import { isValidDate, isValidHHMM, localDateOf, nowIso, todayLocal } from '../domain/time.js';
import type {
  ActionType,
  FreezeReason,
  IncidentType,
  WrittenInstruction,
} from '../domain/types.js';

/* ---------- 行类型 ---------- */

export interface MedicationRow {
  id: string;
  student_id: string;
  guardian_id: string;
  package_code: string;
  label_drug_name: string;
  label_dose_text: string;
  label_manufacturer: string | null;
  expiry_date: string;
  storage_requirement: 'room_temp' | 'refrigerated' | 'cool_dark';
  initial_quantity: number;
  current_quantity: number;
  quantity_unit: string;
  package_state: 'intact' | 'damaged';
  storage_state: 'unknown' | 'ok' | 'breached';
  status: 'intake_pending' | 'in_custody' | 'frozen' | 'returned' | 'depleted';
  freeze_reason: FreezeReason | null;
  current_holder_id: string | null;
  received_at: string | null;
}

interface AuthRow {
  id: string;
  medication_id: string;
  version: number;
  status: 'pending' | 'active' | 'superseded' | 'expired';
  drug_name: string;
  form: string;
  dose_text: string;
  route: string;
  scheduled_times: string;
  valid_from: string;
  valid_until: string;
  notes: string | null;
  submitted_by: string;
  created_at: string;
}

/* ---------- 输入校验 ---------- */

export function validateInstruction(input: unknown): WrittenInstruction {
  if (typeof input !== 'object' || input === null) {
    throw DomainError.badRequest('指示内容格式不正确');
  }
  const o = input as Record<string, unknown>;
  const str = (v: unknown, field: string): string => {
    if (typeof v !== 'string' || v.trim() === '') {
      throw DomainError.badRequest(`字段 ${field} 必须为非空字符串`);
    }
    return v.trim();
  };
  const drugName = str(o.drugName, 'drugName');
  const form = str(o.form, 'form');
  const doseText = str(o.doseText, 'doseText');
  const route = str(o.route, 'route');
  const validFrom = str(o.validFrom, 'validFrom');
  const validUntil = str(o.validUntil, 'validUntil');
  if (!isValidDate(validFrom) || !isValidDate(validUntil)) {
    throw DomainError.badRequest('validFrom/validUntil 必须为 YYYY-MM-DD');
  }
  if (validUntil < validFrom) {
    throw DomainError.badRequest('授权失效日期不能早于生效日期');
  }
  if (!Array.isArray(o.scheduledTimes) || o.scheduledTimes.length === 0) {
    throw DomainError.badRequest('scheduledTimes 至少包含一个 HH:MM 时点');
  }
  const scheduledTimes = (o.scheduledTimes as unknown[]).map((t) => {
    if (!isValidHHMM(t)) throw DomainError.badRequest(`非法计划时点: ${String(t)}`);
    return t;
  });
  return {
    drugName,
    form,
    doseText,
    route,
    scheduledTimes,
    validFrom,
    validUntil,
    notes: typeof o.notes === 'string' ? o.notes.trim() : undefined,
  };
}

/** 剂量文本归一化：忽略大小写/空白差异，数字与单位分别比较（仅用于一致性比对，不做剂量建议）。 */
function normalizeDose(text: string): { n: number; unit: string } | null {
  const m = text.replace(/\s+/g, '').match(/^(\d+(?:\.\d+)?)(.+)$/);
  if (!m) return null;
  const unitAliases: Record<string, string> = {
    ml: 'ml', 毫升: 'ml',
    mg: 'mg', 毫克: 'mg',
    片: 'tablet', tablet: 'tablet', tablets: 'tablet', 粒: 'tablet',
    滴: 'drop', drop: 'drop', drops: 'drop',
  };
  const unit = m[2]!.toLowerCase();
  return { n: Number(m[1]), unit: unitAliases[unit] ?? unit };
}

function doseEqual(a: string, b: string): boolean {
  const na = normalizeDose(a);
  const nb = normalizeDose(b);
  if (na && nb) return na.n === nb.n && na.unit === nb.unit;
  return a.trim().toLowerCase().replace(/\s+/g, '') === b.trim().toLowerCase().replace(/\s+/g, '');
}

function nameEqual(a: string, b: string): boolean {
  return a.trim().toLowerCase().replace(/\s+/g, '') === b.trim().toLowerCase().replace(/\s+/g, '');
}

/* ---------- 服务主体 ---------- */

export class MedicationService {
  constructor(private db: DB) {}

  /* ===== 基础数据 ===== */

  createGuardian(input: { name: string; phone: string; emergencyPhone: string; emergencyNote?: string }) {
    const id = newId('grd');
    const token = newId('tok');
    this.db
      .prepare(
        `INSERT INTO guardians (id, name, phone, emergency_phone, emergency_note, token)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.name, input.phone, input.emergencyPhone, input.emergencyNote ?? null, token);
    return { id, name: input.name, token };
  }

  createStudent(guardianId: string, name: string) {
    this.getGuardian(guardianId);
    const id = newId('stu');
    this.db.prepare(`INSERT INTO students (id, name, guardian_id) VALUES (?, ?, ?)`).run(id, name, guardianId);
    return { id, name, guardianId };
  }

  createStaff(input: { name: string; role: 'teacher' | 'nurse' | 'coordinator'; responsible?: boolean }) {
    const id = newId('stf');
    const token = newId('tok');
    this.db
      .prepare(`INSERT INTO staff (id, name, role, is_responsible, token) VALUES (?, ?, ?, ?, ?)`)
      .run(id, input.name, input.role, input.responsible ? 1 : 0, token);
    return { id, ...input, token };
  }

  getGuardian(id: string) {
    const row = this.db.prepare(`SELECT * FROM guardians WHERE id = ?`).get(id) as
      | { id: string; name: string; phone: string; emergency_phone: string; emergency_note: string | null; token: string }
      | undefined;
    if (!row) throw DomainError.notFound('监护人不存在');
    return row;
  }

  getStaff(id: string) {
    const row = this.db.prepare(`SELECT * FROM staff WHERE id = ? AND active = 1`).get(id) as
      | { id: string; name: string; role: string; is_responsible: number; token: string }
      | undefined;
    if (!row) throw DomainError.notFound('校方人员不存在或已停用');
    return row;
  }

  authenticateToken(token: string) {
    const staff = this.db.prepare(`SELECT * FROM staff WHERE token = ? AND active = 1`).get(token) as
      | { id: string; name: string; role: string; is_responsible: number }
      | undefined;
    if (staff) return { kind: 'staff' as const, id: staff.id, name: staff.name, role: staff.role, responsible: staff.is_responsible === 1 };
    const guardian = this.db.prepare(`SELECT * FROM guardians WHERE token = ?`).get(token) as
      | { id: string; name: string }
      | undefined;
    if (guardian) return { kind: 'guardian' as const, id: guardian.id, name: guardian.name };
    throw DomainError.unauthorized();
  }

  /* ===== 登记（家长） ===== */

  /** 家长登记药品 + 首版书面指示。 */
  registerMedication(input: {
    guardianId: string;
    studentId: string;
    packageCode: string;
    labelDrugName: string;
    labelDoseText: string;
    labelManufacturer?: string;
    expiryDate: string;
    storageRequirement: 'room_temp' | 'refrigerated' | 'cool_dark';
    initialQuantity: number;
    quantityUnit: string;
    packageDamaged?: boolean;
    instruction: WrittenInstruction;
  }) {
    const g = this.getGuardian(input.guardianId);
    const student = this.db.prepare(`SELECT * FROM students WHERE id = ?`).get(input.studentId) as
      | { id: string; guardian_id: string; name: string }
      | undefined;
    if (!student || student.guardian_id !== g.id) throw DomainError.forbidden('只能为本人孩子登记药品');
    if (!isValidDate(input.expiryDate)) throw DomainError.badRequest('expiryDate 必须为 YYYY-MM-DD');
    if (!(input.initialQuantity > 0)) throw DomainError.badRequest('initialQuantity 必须为正数');
    const instruction = validateInstruction(input.instruction);

    return this.db.transaction(() => {
      const medId = newId('med');
      const status = input.packageDamaged ? 'frozen' : 'intake_pending';
      const freezeReason: FreezeReason | null = input.packageDamaged ? 'package_damaged' : null;
      this.db
        .prepare(
          `INSERT INTO medications
             (id, student_id, guardian_id, package_code, label_drug_name, label_dose_text, label_manufacturer,
              expiry_date, storage_requirement, initial_quantity, current_quantity, quantity_unit,
              package_state, storage_state, status, freeze_reason)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unknown', ?, ?)`,
        )
        .run(
          medId, student.id, g.id, input.packageCode, input.labelDrugName, input.labelDoseText,
          input.labelManufacturer ?? null, input.expiryDate, input.storageRequirement,
          input.initialQuantity, input.initialQuantity, input.quantityUnit,
          input.packageDamaged ? 'damaged' : 'intact', status, freezeReason,
        );

      const authId = this.insertAuthVersion(medId, 1, instruction, g.id, 'pending');

      if (input.packageDamaged) {
        this.recordFreeze(medId, 'package_damaged', '登记时家长声明包装破损，待校方核查', 'guardian', g.id);
        this.notify(medId, 'both', 'package_damaged', '药品包装破损已冻结', `药品 ${medId} 登记时包装声明为破损，已冻结执行。`);
      }
      return {
        medicationId: medId,
        authId,
        version: 1,
        status,
        freezeReason,
        note: '登记成功，等待校方接收与双人核对',
      };
    })();
  }

  /** 家长提交指示变更 → 新版本 pending，旧版本立即 superseded，冻结至新版完成双人核对。 */
  submitInstructionChange(guardianId: string, medId: string, instructionInput: unknown) {
    const med = this.getMedication(medId);
    if (med.guardian_id !== guardianId) throw DomainError.forbidden('只能修改本人孩子药品的指示');
    if (med.status === 'returned') throw DomainError.conflict('medication_returned', '药品已退回，不能再修改指示');
    const instruction = validateInstruction(instructionInput);

    return this.db.transaction(() => {
      const last = this.db
        .prepare(`SELECT MAX(version) AS v FROM authorizations WHERE medication_id = ?`)
        .get(medId) as { v: number | null };
      const version = (last.v ?? 0) + 1;
      const authId = this.insertAuthVersion(medId, version, instruction, guardianId, 'pending');
      this.db.prepare(`UPDATE authorizations SET status = 'superseded' WHERE medication_id = ? AND status = 'active'`).run(medId);
      this.freezeState(medId, 'instruction_change_pending');
      this.recordFreeze(medId, 'instruction_change_pending', `家长提交 v${version} 指示，等待双人核对`, 'guardian', guardianId);
      this.notify(medId, 'both', 'instruction_change', '用药指示已变更，等待重新核对',
        `药品 ${medId} 的书面指示更新到 v${version}，核对完成前暂停执行。`);
      return { medicationId: medId, authId, version, status: 'frozen', freezeReason: 'instruction_change_pending' };
    })();
  }

  /* ===== 校方流程 ===== */

  /** 接收：核对有效期与外观/保管条件，建立保管链起点。 */
  receive(
    staffId: string,
    medId: string,
    opts: { packageIntact: boolean; storageMet: boolean; note?: string },
    idem?: { key: string; deviceId?: string },
  ) {
    this.checkReplay(idem);
    const staff = this.getStaff(staffId);
    const med = this.getMedication(medId);
    if (med.status !== 'intake_pending' && !(med.status === 'frozen' && med.freeze_reason === 'package_damaged' && med.received_at === null)) {
      throw DomainError.conflict('not_receivable', `当前状态 ${med.status} 不能接收（重复扫码不会产生第二次接收）`);
    }
    if (med.expiry_date < todayLocal()) {
      throw DomainError.conflict('medication_expired', `药品已过有效期（${med.expiry_date}），不能接收，请退回家长`);
    }

    return this.runIdempotent('receive', medId, idem, () =>
      this.db.transaction(() => {
        const now = nowIso();
        const freeze = !opts.packageIntact || !opts.storageMet;
        const reason: FreezeReason | null = !opts.packageIntact
          ? 'package_damaged'
          : !opts.storageMet
            ? 'storage_breach'
            : null;

        this.db
          .prepare(
            `UPDATE medications
               SET status = ?, freeze_reason = ?, current_holder_id = ?, received_at = COALESCE(received_at, ?),
                   package_state = ?, storage_state = ?, updated_at = datetime('now')
             WHERE id = ?`,
          )
          .run(
            freeze ? 'frozen' : 'in_custody',
            reason,
            staff.id,
            now,
            opts.packageIntact ? 'intact' : 'damaged',
            opts.storageMet ? 'ok' : 'breached',
            medId,
          );

        this.db
          .prepare(
            `INSERT INTO custody_events (id, medication_id, type, from_staff_id, to_staff_id, quantity_at_event, note, actor_id)
             VALUES (?, ?, 'receive', NULL, ?, ?, ?, ?)`,
          )
          .run(newId('cus'), medId, staff.id, med.current_quantity, opts.note ?? null, staff.id);

        if (!opts.packageIntact) {
          this.recordFreeze(medId, 'package_damaged', '接收时发现包装破损', 'staff', staff.id);
          this.notify(medId, 'both', 'freeze', '药品因包装破损已冻结', `接收人 ${staff.name} 发现包装破损。`);
        } else if (!opts.storageMet) {
          this.recordFreeze(medId, 'storage_breach', '接收时保管条件不满足', 'staff', staff.id);
          this.notify(medId, 'both', 'freeze', '药品因保管条件失效已冻结', `接收人 ${staff.name} 确认保管条件未满足。`);
        }
        return {
          medicationId: medId,
          action: 'receive',
          status: freeze ? 'frozen' : 'in_custody',
          holderId: staff.id,
          freezeReason: reason,
          quantity: med.current_quantity,
        };
      })(),
    );
  }

  /** 双人核对：两名在岗人员对指定授权版本做一致性核对，服务端独立比对标签与指示。 */
  verify(
    staffId: string,
    medId: string,
    opts: { authId?: string; staff1Id: string; staff2Id: string; storageMet: boolean; note?: string },
    idem?: { key: string; deviceId?: string },
  ) {
    this.checkReplay(idem);
    const actor = this.getStaff(staffId);
    const med = this.getMedication(medId);
    if (med.status === 'returned' || med.status === 'depleted' || med.status === 'intake_pending') {
      throw DomainError.conflict('not_verifiable', `当前状态 ${med.status} 不能核对`);
    }
    const s1 = this.getStaff(opts.staff1Id);
    const s2 = this.getStaff(opts.staff2Id);
    if (s1.id === s2.id) throw DomainError.badRequest('双人核对必须由两名不同人员完成');

    return this.runIdempotent('verify', medId, idem, () =>
      this.db.transaction(() => {
        const auth = opts.authId
          ? (this.db.prepare(`SELECT * FROM authorizations WHERE id = ? AND medication_id = ?`).get(opts.authId, medId) as AuthRow | undefined)
          : (this.db
              .prepare(`SELECT * FROM authorizations WHERE medication_id = ? ORDER BY version DESC LIMIT 1`)
              .get(medId) as AuthRow | undefined);
        if (!auth) throw DomainError.notFound('授权版本不存在');

        // 同一版本已核对通过：重复扫码直接回放既有结论，不产生第二次核对动作；
        // 之前核对为 conflict 时允许再次核对（如已更换与指示一致的包装），历次核对均保留供审计。
        const existing = this.db
          .prepare(`SELECT * FROM verifications WHERE auth_id = ? ORDER BY created_at DESC LIMIT 1`)
          .get(auth.id) as { id: string; result: 'verified' | 'conflict' } | undefined;
        if (existing && existing.result === 'verified') {
          return { medicationId: medId, action: 'verify', duplicated: true, verificationId: existing.id, result: existing.result };
        }

        const today = todayLocal();
        const nameMatch = nameEqual(auth.drug_name, med.label_drug_name);
        const doseMatch = doseEqual(auth.dose_text, med.label_dose_text);
        const labelMatch = nameMatch && doseMatch;
        const packageIntact = med.package_state === 'intact';
        const inWindow = today >= auth.valid_from && today <= auth.valid_until;
        const drugNotExpired = med.expiry_date >= today;

        const conflicts: string[] = [];
        if (!nameMatch) conflicts.push(`药品名不一致：指示「${auth.drug_name}」/ 标签「${med.label_drug_name}」`);
        if (!doseMatch) conflicts.push(`剂量不一致：指示「${auth.dose_text}」/ 标签「${med.label_dose_text}」`);
        if (!inWindow) conflicts.push(`授权不在有效期内（${auth.valid_from} ~ ${auth.valid_until}）`);
        if (!drugNotExpired) conflicts.push(`药品已过有效期（${med.expiry_date}）`);
        if (!packageIntact) conflicts.push('包装破损');
        if (!opts.storageMet) conflicts.push('保管条件不满足');

        const result = conflicts.length === 0 ? 'verified' : 'conflict';
        const verId = newId('ver');
        this.db
          .prepare(
            `INSERT INTO verifications
               (id, medication_id, auth_id, auth_version, staff1_id, staff2_id, result,
                label_match, package_intact, storage_met, conflict_detail)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            verId, medId, auth.id, auth.version, s1.id, s2.id, result,
            labelMatch ? 1 : 0, packageIntact ? 1 : 0, opts.storageMet ? 1 : 0,
            conflicts.length ? conflicts.join('；') : null,
          );

        if (result === 'verified') {
          this.db.prepare(`UPDATE authorizations SET status = 'active' WHERE id = ?`).run(auth.id);
          this.db
            .prepare(`UPDATE authorizations SET status = 'superseded' WHERE medication_id = ? AND id <> ? AND status IN ('pending','active')`)
            .run(medId, auth.id);
          this.db
            .prepare(`UPDATE medications SET status = 'in_custody', freeze_reason = NULL, storage_state = 'ok', updated_at = datetime('now') WHERE id = ?`)
            .run(medId);
          this.recordUnfreeze(medId, `v${auth.version} 双人核对通过`, 'staff', actor.id);
        } else {
          const reason: FreezeReason = !inWindow || !drugNotExpired ? 'auth_expired' : 'info_conflict';
          this.db.prepare(`UPDATE authorizations SET status = 'superseded' WHERE id = ? AND status = 'pending'`).run(auth.id);
          this.freezeState(medId, reason);
          this.recordFreeze(medId, reason, conflicts.join('；'), 'staff', actor.id);
          this.notify(medId, 'both', 'verification_conflict', '双人核对发现冲突，执行已冻结',
            `药品 ${medId} v${auth.version} 核对冲突：${conflicts.join('；')}。请联系家长，校方不做剂量判断。`);
        }
        return {
          medicationId: medId,
          action: 'verify',
          verificationId: verId,
          authVersion: auth.version,
          result,
          labelMatch,
          conflicts,
          staff: [s1.id, s2.id],
        };
      })(),
    );
  }

  /** 跨班交接：数量必须与账面一致，保管人即时变更，形成交接链。 */
  handoff(
    staffId: string,
    medId: string,
    opts: { toStaffId: string; quantity: number; note?: string },
    idem?: { key: string; deviceId?: string },
  ) {
    this.checkReplay(idem);
    const actor = this.getStaff(staffId);
    const med = this.getMedication(medId);
    const to = this.getStaff(opts.toStaffId);
    if (med.status === 'returned' || med.status === 'depleted' || med.status === 'intake_pending') {
      throw DomainError.conflict('not_handoffable', `当前状态 ${med.status} 不能交接`);
    }
    if (!med.current_holder_id) throw DomainError.conflict('no_holder', '药品尚无保管人');
    if (med.current_holder_id !== actor.id) {
      throw DomainError.conflict('not_holder', `只有当前保管人可以交出（当前保管人：${med.current_holder_id}）`);
    }
    if (to.id === actor.id) throw DomainError.badRequest('不能交接给自己');
    if (!(opts.quantity > 0)) throw DomainError.badRequest('交接数量必须为正数');
    if (Math.abs(opts.quantity - med.current_quantity) > 1e-9) {
      throw DomainError.conflict(
        'quantity_mismatch',
        `交接数量 ${opts.quantity} 与账面数量 ${med.current_quantity} 不一致，交接中止`,
        { claimed: opts.quantity, recorded: med.current_quantity },
      );
    }

    return this.runIdempotent('handoff', medId, idem, () =>
      this.db.transaction(() => {
        this.db
          .prepare(`UPDATE medications SET current_holder_id = ?, updated_at = datetime('now') WHERE id = ?`)
          .run(to.id, medId);
        const evtId = newId('cus');
        this.db
          .prepare(
            `INSERT INTO custody_events (id, medication_id, type, from_staff_id, to_staff_id, quantity_at_event, note, actor_id)
             VALUES (?, ?, 'handoff', ?, ?, ?, ?, ?)`,
          )
          .run(evtId, medId, actor.id, to.id, med.current_quantity, opts.note ?? null, actor.id);
        return {
          custodyEventId: evtId,
          medicationId: medId,
          action: 'handoff',
          fromStaffId: actor.id,
          toStaffId: to.id,
          quantity: med.current_quantity,
          frozen: med.status === 'frozen',
        };
      })(),
    );
  }

  /** 实际执行：只有在保管中、授权有效且已双人核对通过时允许；确认后不可删除。 */
  execute(
    staffId: string,
    medId: string,
    opts: {
      scheduledDate?: string;
      scheduledTime: string;
      administeredQty: number;
      occurredAt?: string;
    },
    idem?: { key: string; deviceId?: string },
  ) {
    this.checkReplay(idem);
    const staff = this.getStaff(staffId);
    const med = this.getMedication(medId);

    if (med.status === 'frozen') {
      throw DomainError.conflict('medication_frozen', `药品处于冻结状态（${med.freeze_reason ?? ''}），不能执行`);
    }
    if (med.status !== 'in_custody') {
      throw DomainError.conflict('not_in_custody', `当前状态 ${med.status} 不能执行`);
    }
    if (med.current_holder_id !== staff.id) {
      throw DomainError.conflict('not_holder', '只能由当前保管人执行给药');
    }
    if (!(opts.administeredQty > 0)) throw DomainError.badRequest('administeredQty 必须为正数');

    const occurredAt = opts.occurredAt ?? nowIso();
    if (Number.isNaN(Date.parse(occurredAt))) throw DomainError.badRequest('occurredAt 非法时间');
    if (new Date(occurredAt).getTime() > Date.now() + 60_000) {
      throw DomainError.badRequest('执行时间不能晚于当前时间（不允许预登未来给药）');
    }
    const scheduledDate = opts.scheduledDate ?? localDateOf(occurredAt);
    if (!isValidDate(scheduledDate)) throw DomainError.badRequest('scheduledDate 必须为 YYYY-MM-DD');
    if (!isValidHHMM(opts.scheduledTime)) throw DomainError.badRequest('scheduledTime 必须为 HH:MM');

    return this.runIdempotent('execute', medId, idem, () =>
      this.db.transaction(() => {
        const auth = this.activeAuth(medId);
        const times = JSON.parse(auth.scheduled_times) as string[];
        if (!times.includes(opts.scheduledTime)) {
          throw DomainError.badRequest(`时点 ${opts.scheduledTime} 不在授权 v${auth.version} 计划中（${times.join(', ')}）`);
        }
        const verification = this.db
          .prepare(`SELECT * FROM verifications WHERE auth_id = ? AND result = 'verified' ORDER BY created_at DESC LIMIT 1`)
          .get(auth.id) as { id: string; staff1_id: string; staff2_id: string } | undefined;
        if (!verification) throw DomainError.conflict('not_verified', '当前指示尚未通过双人核对');

        if (opts.administeredQty - med.current_quantity > 1e-9) {
          throw DomainError.conflict('insufficient_quantity', `数量不足：账面 ${med.current_quantity}，申请使用 ${opts.administeredQty}`);
        }

        const before = med.current_quantity;
        const after = Number((before - opts.administeredQty).toFixed(6));
        const backfilled = new Date(occurredAt).getTime() < Date.now() - 120_000 ? 1 : 0;
        const execId = newId('exe');
        try {
          this.db
            .prepare(
              `INSERT INTO executions
                 (id, medication_id, auth_id, auth_version, scheduled_date, scheduled_time, executed_by,
                  quantity_before, quantity_after, administered_qty, occurred_at, device_id, backfilled)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              execId, medId, auth.id, auth.version, scheduledDate, opts.scheduledTime, staff.id,
              before, after, opts.administeredQty, occurredAt, idem?.deviceId ?? null, backfilled,
            );
        } catch (e) {
          // 同一计划时点重复领取（含并发）：唯一索引拒绝第二次动作
          if (isUniqueViolation(e)) {
            const prior = this.db
              .prepare(`SELECT id FROM executions WHERE medication_id = ? AND scheduled_date = ? AND scheduled_time = ?`)
              .get(medId, scheduledDate, opts.scheduledTime) as { id: string };
            throw DomainError.conflict('slot_already_executed', '该计划时点已执行，重复扫码不能形成第二次执行', {
              existingExecutionId: prior.id,
            });
          }
          throw e;
        }

        const newStatus = after === 0 ? 'depleted' : 'in_custody';
        this.db
          .prepare(`UPDATE medications SET current_quantity = ?, status = ?, updated_at = datetime('now') WHERE id = ?`)
          .run(after, newStatus, medId);

        return {
          executionId: execId,
          medicationId: medId,
          action: 'execute',
          authVersion: auth.version,
          scheduledDate,
          scheduledTime: opts.scheduledTime,
          quantityBefore: before,
          quantityAfter: after,
          administeredQty: opts.administeredQty,
          executedBy: staff.id,
          occurredAt,
          backfilled: backfilled === 1,
          depleted: newStatus === 'depleted',
        };
      })(),
    );
  }

  /** 追加差错/异常事件：漏执行、学生拒绝、误差等；永不修改或删除执行记录。 */
  reportIncident(
    staffId: string,
    medId: string,
    opts: {
      type: IncidentType;
      detail?: string;
      scheduledDate?: string;
      scheduledTime?: string;
      occurredAt?: string;
    },
    idem?: { key: string; deviceId?: string },
  ) {
    this.checkReplay(idem);
    const staff = this.getStaff(staffId);
    const med = this.getMedication(medId);
    if (med.status === 'returned') throw DomainError.conflict('medication_returned', '药品已退回');
    const allowed: IncidentType[] = ['missed_dose', 'student_refused', 'dose_deviation', 'package_damaged', 'storage_breach', 'other'];
    if (!allowed.includes(opts.type)) throw DomainError.badRequest('未知事件类型');
    const occurredAt = opts.occurredAt ?? nowIso();
    if (Number.isNaN(Date.parse(occurredAt))) throw DomainError.badRequest('occurredAt 非法时间');
    if (new Date(occurredAt).getTime() > Date.now() + 60_000) {
      throw DomainError.badRequest('事件时间不能晚于当前时间');
    }
    if (opts.scheduledDate !== undefined && !isValidDate(opts.scheduledDate)) throw DomainError.badRequest('scheduledDate 非法');
    if (opts.scheduledTime !== undefined && !isValidHHMM(opts.scheduledTime)) throw DomainError.badRequest('scheduledTime 非法');

    return this.runIdempotent('incident', medId, idem, () =>
      this.db.transaction(() => {
        let authId: string | null = null;
        let authVersion: number | null = null;
        try {
          const auth = this.activeAuth(medId);
          authId = auth.id;
          authVersion = auth.version;
        } catch {
          // 冻结/无 active 授权时事件仍可追加，auth 字段留空
        }
        const incId = newId('inc');
        this.db
          .prepare(
            `INSERT INTO incidents
               (id, medication_id, auth_id, auth_version, type, detail, scheduled_date, scheduled_time,
                reported_by, occurred_at, device_id, backfilled)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            incId, medId, authId, authVersion, opts.type, opts.detail ?? null,
            opts.scheduledDate ?? null, opts.scheduledTime ?? null, staff.id, occurredAt,
            idem?.deviceId ?? null,
            new Date(occurredAt).getTime() < Date.now() - 120_000 ? 1 : 0,
          );

        const titles: Record<IncidentType, string> = {
          missed_dose: '漏执行',
          student_refused: '学生拒绝服药',
          dose_deviation: '给药误差',
          package_damaged: '包装破损',
          storage_breach: '保管条件失效',
          other: '其他异常',
        };
        this.notify(medId, 'both', `incident_${opts.type}`, titles[opts.type],
          `药品 ${medId} 记录${titles[opts.type]}${opts.detail ? `：${opts.detail}` : ''}。`);

        if (opts.type === 'package_damaged' || opts.type === 'storage_breach') {
          const reason: FreezeReason = opts.type === 'package_damaged' ? 'package_damaged' : 'storage_breach';
          this.db
            .prepare(
              `UPDATE medications SET status = 'frozen', freeze_reason = ?,
                 package_state = CASE WHEN ? = 'package_damaged' THEN 'damaged' ELSE package_state END,
                 storage_state = CASE WHEN ? = 'storage_breach' THEN 'breached' ELSE storage_state END,
                 updated_at = datetime('now') WHERE id = ?`,
            )
            .run(reason, opts.type, opts.type, medId);
          this.recordFreeze(medId, reason, opts.detail ?? titles[opts.type], 'staff', staff.id);
        }
        return { incidentId: incId, medicationId: medId, action: 'incident', type: opts.type, freezes: opts.type === 'package_damaged' || opts.type === 'storage_breach' };
      })(),
    );
  }

  /** 退回家长：结束保管链；重复扫码不会形成第二次退回。 */
  returnMedication(staffId: string, medId: string, opts: { note?: string }, idem?: { key: string; deviceId?: string }) {
    this.checkReplay(idem);
    const staff = this.getStaff(staffId);
    const med = this.getMedication(medId);
    if (med.status === 'returned') {
      const prior = this.db
        .prepare(`SELECT id FROM custody_events WHERE medication_id = ? AND type = 'return'`)
        .get(medId) as { id: string } | undefined;
      throw DomainError.conflict('already_returned', '药品已退回，重复扫码不能形成第二次退回', {
        existingReturnId: prior?.id,
      });
    }

    return this.runIdempotent('return', medId, idem, () =>
      this.db.transaction(() => {
        if (!med.current_holder_id && med.status !== 'intake_pending') {
          throw DomainError.conflict('no_holder', '药品不在任何保管人名下');
        }
        const evtId = newId('cus');
        this.db
          .prepare(
            `INSERT INTO custody_events (id, medication_id, type, from_staff_id, to_staff_id, quantity_at_event, note, actor_id)
             VALUES (?, ?, 'return', ?, NULL, ?, ?, ?)`,
          )
          .run(evtId, medId, med.current_holder_id, med.current_quantity, opts.note ?? null, staff.id);
        this.db
          .prepare(
            `UPDATE medications SET status = 'returned', freeze_reason = NULL, current_holder_id = NULL, updated_at = datetime('now') WHERE id = ?`,
          )
          .run(medId);
        this.db.prepare(`UPDATE authorizations SET status = 'superseded' WHERE medication_id = ? AND status IN ('pending','active')`).run(medId);
        this.notify(medId, 'guardian', 'returned', '药品已退回', `药品 ${medId} 已退回，剩余数量 ${med.current_quantity}。`);
        return { custodyEventId: evtId, medicationId: medId, action: 'return', returnedQuantity: med.current_quantity };
      })(),
    );
  }

  /** 离线补传：按数组顺序逐条处理执行/差错事件，每条独立事务与幂等键，可安全重放。 */
  backfill(staffId: string, medId: string, events: unknown[]) {
    this.getStaff(staffId);
    this.getMedication(medId);
    if (!Array.isArray(events) || events.length === 0) throw DomainError.badRequest('events 不能为空');

    const out: unknown[] = [];
    for (const [i, raw] of events.entries()) {
      if (typeof raw !== 'object' || raw === null) throw DomainError.badRequest(`第 ${i + 1} 条事件格式错误`);
      const e = raw as Record<string, unknown>;
      const clientEventId = String(e.clientEventId ?? `seq${i + 1}`);
      const deviceId = typeof e.deviceId === 'string' ? e.deviceId : 'unknown-device';
      const idem = { key: `${deviceId}:${clientEventId}`, deviceId };
      try {
        if (e.kind === 'execution') {
          if (typeof e.scheduledTime !== 'string' || typeof e.occurredAt !== 'string' || !(Number(e.administeredQty) > 0)) {
            throw DomainError.badRequest(`第 ${i + 1} 条执行事件缺少 scheduledTime/occurredAt/administeredQty`);
          }
          out.push(
            this.execute(
              staffId,
              medId,
              {
                scheduledDate: typeof e.scheduledDate === 'string' ? e.scheduledDate : undefined,
                scheduledTime: e.scheduledTime,
                administeredQty: Number(e.administeredQty),
                occurredAt: e.occurredAt,
              },
              idem,
            ),
          );
        } else if (e.kind === 'incident') {
          if (typeof e.type !== 'string' || typeof e.occurredAt !== 'string') {
            throw DomainError.badRequest(`第 ${i + 1} 条异常事件缺少 type/occurredAt`);
          }
          out.push(
            this.reportIncident(
              staffId,
              medId,
              {
                type: e.type as IncidentType,
                detail: typeof e.detail === 'string' ? e.detail : undefined,
                scheduledDate: typeof e.scheduledDate === 'string' ? e.scheduledDate : undefined,
                scheduledTime: typeof e.scheduledTime === 'string' ? e.scheduledTime : undefined,
                occurredAt: e.occurredAt,
              },
              idem,
            ),
          );
        } else {
          throw DomainError.badRequest(`第 ${i + 1} 条事件 kind 必须为 execution/incident`);
        }
      } catch (err) {
        // 重复补传已处理过的事件：回放首次结果，不报错、不重复落库
        if (err instanceof IdempotentReplay) {
          out.push({ replayed: true, clientEventId, result: err.payload });
        } else {
          throw err;
        }
      }
    }
    return { medicationId: medId, processed: out.length, results: out };
  }

  /** 定时巡检：授权到期 / 药品过期 → 冻结并通知。 */
  sweepExpirations(): { frozen: string[] } {
    const today = todayLocal();
    const candidates = this.db
      .prepare(
        `SELECT id FROM medications
          WHERE status IN ('in_custody','frozen')`,
      )
      .all() as { id: string }[];

    const frozen: string[] = [];
    for (const { id } of candidates) {
      const med = this.getMedication(id);
      const reason: FreezeReason | null =
        med.freeze_reason !== null && med.freeze_reason !== 'auth_expired'
          ? med.freeze_reason // 已有更具体冻结原因则保留
          : med.expiry_date < today
            ? 'auth_expired'
            : (() => {
                const active = this.db
                  .prepare(`SELECT * FROM authorizations WHERE medication_id = ? AND status = 'active'`)
                  .get(id) as AuthRow | undefined;
                if (!active) return med.freeze_reason;
                return active.valid_until < today ? 'auth_expired' : null;
              })();
      if (reason === 'auth_expired' && med.freeze_reason !== 'auth_expired') {
        this.db.transaction(() => {
          this.freezeState(id, 'auth_expired');
          this.db.prepare(`UPDATE authorizations SET status = 'expired' WHERE medication_id = ? AND status = 'active' AND valid_until < ?`).run(id, today);
          this.recordFreeze(id, 'auth_expired', '系统巡检：授权到期或药品过期', 'system', null);
          this.notify(id, 'both', 'auth_expired', '授权已到期，执行冻结', `药品 ${id} 授权到期，请家长重新提交书面指示。`);
        })();
        frozen.push(id);
      }
    }
    return { frozen };
  }

  /* ===== 查询视图 ===== */

  /** 家长视图：本人孩子的确认状态与异常通知。 */
  guardianView(guardianId: string) {
    const g = this.getGuardian(guardianId);
    const students = this.db
      .prepare(
        `SELECT s.id AS student_id, s.name AS student_name,
                m.id AS medication_id, m.status, m.freeze_reason, m.current_quantity, m.quantity_unit,
                m.package_code, m.label_drug_name, m.label_dose_text, m.expiry_date,
                m.storage_requirement, m.current_holder_id, st.name AS holder_name, m.received_at
         FROM students s
         JOIN medications m ON m.student_id = s.id
         LEFT JOIN staff st ON st.id = m.current_holder_id
         WHERE s.guardian_id = ?
         ORDER BY m.created_at DESC`,
      )
      .all(g.id) as Record<string, unknown>[];

    return students.map((row) => {
      const medId = row.medication_id as string;
      const auth = this.db
        .prepare(`SELECT * FROM authorizations WHERE medication_id = ? ORDER BY version DESC LIMIT 1`)
        .get(medId) as AuthRow;
      const verification = this.db
        .prepare(`SELECT * FROM verifications WHERE medication_id = ? ORDER BY created_at DESC LIMIT 1`)
        .get(medId) as { result: string; staff1_id: string; staff2_id: string } | undefined;
      const executions = this.db
        .prepare(
          `SELECT id, scheduled_date, scheduled_time, occurred_at, administered_qty, quantity_after, backfilled
           FROM executions WHERE medication_id = ? ORDER BY occurred_at DESC LIMIT 10`,
        )
        .all(medId);
      const incidents = this.db
        .prepare(`SELECT id, type, detail, occurred_at FROM incidents WHERE medication_id = ? ORDER BY occurred_at DESC LIMIT 10`)
        .all(medId);
      const notifications = this.db
        .prepare(`SELECT id, type, title, body, read_at, created_at FROM notifications WHERE medication_id = ? AND audience IN ('guardian','both') ORDER BY created_at DESC`)
        .all(medId);
      return {
        ...row,
        currentInstruction: {
          version: auth.version,
          status: auth.status,
          doseText: auth.dose_text,
          scheduledTimes: JSON.parse(auth.scheduled_times),
          validUntil: auth.valid_until,
        },
        confirmation: verification
          ? {
              result: verification.result,
              confirmedBy: [verification.staff1_id, verification.staff2_id],
            }
          : null,
        recentExecutions: executions,
        recentIncidents: incidents,
        notifications,
      };
    });
  }

  /** 学校审计视图：从药品或单次执行追到授权版本、核对人员、交接链、剩余数量。 */
  auditView(medId: string) {
    const med = this.getMedication(medId);
    const auths = this.db
      .prepare(
        `SELECT a.*,
                (SELECT json_group_array(json_object(
                   'verificationId', v.id, 'result', v.result, 'staff1Id', v.staff1_id,
                   'staff1Name', s1.name, 'staff2Id', v.staff2_id, 'staff2Name', s2.name,
                   'labelMatch', v.label_match, 'packageIntact', v.package_intact,
                   'storageMet', v.storage_met, 'conflictDetail', v.conflict_detail,
                   'createdAt', v.created_at))
                   FROM verifications v
                   JOIN staff s1 ON s1.id = v.staff1_id
                   JOIN staff s2 ON s2.id = v.staff2_id
                   WHERE v.auth_id = a.id) AS verifications
         FROM authorizations a WHERE a.medication_id = ? ORDER BY a.version`,
      )
      .all(medId) as (AuthRow & { verifications: string })[];

    const custodyChain = this.db
      .prepare(
        `SELECT c.id, c.type, c.from_staff_id, sf.name AS from_name, c.to_staff_id, st.name AS to_name,
                c.quantity_at_event, c.note, c.actor_id, sa.name AS actor_name, c.created_at
         FROM custody_events c
         LEFT JOIN staff sf ON sf.id = c.from_staff_id
         LEFT JOIN staff st ON st.id = c.to_staff_id
         LEFT JOIN staff sa ON sa.id = c.actor_id
         WHERE c.medication_id = ? ORDER BY c.created_at, c.rowid`,
      )
      .all(medId);

    const executions = this.db
      .prepare(
        `SELECT e.*, s.name AS executed_by_name
         FROM executions e JOIN staff s ON s.id = e.executed_by
         WHERE e.medication_id = ? ORDER BY e.occurred_at, e.rowid`,
      )
      .all(medId);

    const incidents = this.db
      .prepare(
        `SELECT i.*, s.name AS reported_by_name FROM incidents i
         JOIN staff s ON s.id = i.reported_by WHERE i.medication_id = ? ORDER BY i.occurred_at, i.rowid`,
      )
      .all(medId);

    const freezes = this.db
      .prepare(`SELECT * FROM freeze_events WHERE medication_id = ? ORDER BY created_at, rowid`)
      .all(medId);

    return {
      medication: {
        ...med,
        storage_state: med.storage_state,
      },
      authorizations: auths.map((a) => ({
        id: a.id,
        version: a.version,
        status: a.status,
        drugName: a.drug_name,
        doseText: a.dose_text,
        scheduledTimes: JSON.parse(a.scheduled_times),
        validFrom: a.valid_from,
        validUntil: a.valid_until,
        submittedBy: a.submitted_by,
        createdAt: a.created_at,
        verifications: JSON.parse(a.verifications),
      })),
      custodyChain,
      executions,
      incidents,
      freezeEvents: freezes,
      remainingQuantity: med.current_quantity,
      quantityUnit: med.quantity_unit,
    };
  }

  /** 从一次执行回溯：授权版本、核对人员、交接链、剩余数量。 */
  executionTrace(executionId: string) {
    const e = this.db
      .prepare(
        `SELECT e.*, s.name AS executed_by_name FROM executions e
         JOIN staff s ON s.id = e.executed_by WHERE e.id = ?`,
      )
      .get(executionId) as
      | (Record<string, unknown> & {
          medication_id: string; auth_id: string; auth_version: number;
          quantity_before: number; quantity_after: number;
        })
      | undefined;
    if (!e) throw DomainError.notFound('执行记录不存在（执行记录一经确认不可删除）');

    const verifications = this.db
      .prepare(
        `SELECT v.*, s1.name AS staff1_name, s2.name AS staff2_name FROM verifications v
         JOIN staff s1 ON s1.id = v.staff1_id JOIN staff s2 ON s2.id = v.staff2_id
         WHERE v.auth_id = ? ORDER BY v.created_at`,
      )
      .all(e.auth_id);

    // 执行发生时点之前的交接链（按记录时间近似还原当时保管路径）
    const chain = this.db
      .prepare(
        `SELECT c.id, c.type, c.from_staff_id, sf.name AS from_name, c.to_staff_id, st.name AS to_name,
                c.quantity_at_event, c.created_at
         FROM custody_events c
         LEFT JOIN staff sf ON sf.id = c.from_staff_id
         LEFT JOIN staff st ON st.id = c.to_staff_id
         WHERE c.medication_id = ? AND c.created_at <= ? ORDER BY c.created_at, c.rowid`,
      )
      .all(e.medication_id, e.occurred_at as string);

    const med = this.getMedication(e.medication_id);
    return {
      execution: e,
      authorization: this.db.prepare(`SELECT * FROM authorizations WHERE id = ?`).get(e.auth_id),
      verifications,
      custodyChainAtTime: chain,
      currentRemainingQuantity: med.current_quantity,
    };
  }

  listNotifications(audience: 'guardian' | 'responsible', guardianId?: string) {
    if (audience === 'guardian') {
      return this.db
        .prepare(
          `SELECT n.* FROM notifications n
           JOIN medications m ON m.id = n.medication_id
           WHERE m.guardian_id = ? AND n.audience IN ('guardian','both')
           ORDER BY n.created_at DESC`,
        )
        .all(guardianId);
    }
    return this.db
      .prepare(
        `SELECT n.* FROM notifications n
         WHERE n.audience IN ('responsible_staff','both')
         ORDER BY n.created_at DESC`,
      )
      .all();
  }

  /* ===== 内部辅助 ===== */

  private getMedication(id: string): MedicationRow {
    const row = this.db.prepare(`SELECT * FROM medications WHERE id = ?`).get(id) as MedicationRow | undefined;
    if (!row) throw DomainError.notFound('药品不存在');
    return row;
  }

  private activeAuth(medId: string): AuthRow {
    const today = todayLocal();
    const auth = this.db
      .prepare(`SELECT * FROM authorizations WHERE medication_id = ? AND status = 'active'`)
      .get(medId) as AuthRow | undefined;
    if (!auth) throw DomainError.conflict('no_active_authorization', '没有已确认的有效书面指示');
    if (today < auth.valid_from || today > auth.valid_until) {
      throw DomainError.conflict('authorization_out_of_window', `授权不在有效期内（${auth.valid_from} ~ ${auth.valid_until}）`);
    }
    return auth;
  }

  private insertAuthVersion(medId: string, version: number, ins: WrittenInstruction, guardianId: string, status: 'pending' | 'active') {
    const id = newId('aut');
    this.db
      .prepare(
        `INSERT INTO authorizations
           (id, medication_id, version, status, drug_name, form, dose_text, route, scheduled_times,
            valid_from, valid_until, notes, submitted_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id, medId, version, status, ins.drugName, ins.form, ins.doseText, ins.route,
        JSON.stringify(ins.scheduledTimes), ins.validFrom, ins.validUntil, ins.notes ?? null, guardianId,
      );
    return id;
  }

  private freezeState(medId: string, reason: FreezeReason) {
    this.db
      .prepare(`UPDATE medications SET status = 'frozen', freeze_reason = ?, updated_at = datetime('now') WHERE id = ? AND status <> 'returned'`)
      .run(reason, medId);
  }

  private recordFreeze(medId: string, reason: FreezeReason, detail: string, actorKind: 'staff' | 'guardian' | 'system', actorId: string | null) {
    this.db
      .prepare(`INSERT INTO freeze_events (id, medication_id, action, reason, detail, actor_kind, actor_id) VALUES (?, ?, 'freeze', ?, ?, ?, ?)`)
      .run(newId('frz'), medId, reason, detail, actorKind, actorId);
  }

  private recordUnfreeze(medId: string, detail: string, actorKind: 'staff' | 'guardian' | 'system', actorId: string | null) {
    this.db
      .prepare(
        `UPDATE medications SET freeze_reason = NULL, updated_at = datetime('now') WHERE id = ? AND status = 'frozen'`,
      )
      .run(medId);
    this.db
      .prepare(`INSERT INTO freeze_events (id, medication_id, action, reason, detail, actor_kind, actor_id) VALUES (?, ?, 'unfreeze', NULL, ?, ?, ?)`)
      .run(newId('frz'), medId, detail, actorKind, actorId);
  }

  private notify(medId: string, audience: 'guardian' | 'responsible_staff' | 'both', type: string, title: string, body: string) {
    this.db
      .prepare(`INSERT INTO notifications (id, medication_id, audience, type, title, body) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(newId('ntf'), medId, audience, type, title, body);
  }

  /**
   * 幂等前置检查：任何业务校验之前先查幂等键，命中则回放首次结果。
   * 保证即使药品后续被交接/冻结/退回，旧扫码事件的重试仍返回首次响应而非报错。
   */
  private checkReplay(idem: { key: string; deviceId?: string } | undefined): void {
    if (!idem?.key) return;
    const existing = this.db.prepare(`SELECT response FROM action_idempotency WHERE idem_key = ?`).get(idem.key) as
      | { response: string }
      | undefined;
    if (existing && existing.response !== '') {
      this.db.prepare(`UPDATE action_idempotency SET replayed = 1 WHERE idem_key = ?`).run(idem.key);
      throw new IdempotentReplay(JSON.parse(existing.response));
    }
  }

  /**
   * 幂等执行：同一 idem_key 的重复请求（含扫码重试、离线补传重放）直接回放首次结果，
   * 不产生第二次业务动作。幂等键与业务数据在同一事务内：先占位、再执行业务、最后存响应，
   * 保证并发下只有一个请求能真正提交。
   */
  private runIdempotent<T>(action: ActionType, medId: string, idem: { key: string; deviceId?: string } | undefined, fn: () => T): T {
    if (!idem?.key) return fn();
    try {
      return this.db.transaction((): T => {
        const existing = this.db.prepare(`SELECT * FROM action_idempotency WHERE idem_key = ?`).get(idem.key) as
          | { response: string; ref_id: string }
          | undefined;
        if (existing) {
          throw new IdempotentReplay(JSON.parse(existing.response));
        }
        // 立即占位，阻止并发请求进入业务逻辑
        this.db
          .prepare(
            `INSERT INTO action_idempotency (idem_key, action_type, medication_id, ref_id, response)
             VALUES (?, ?, ?, ?, '')`,
          )
          .run(idem.key, action, medId, newId('act'));

        const result = fn(); // 内部事务在此变为 SAVEPOINT
        const refId = extractRefId(result) ?? newId('act');
        this.db
          .prepare(`UPDATE action_idempotency SET ref_id = ?, response = ? WHERE idem_key = ?`)
          .run(refId, JSON.stringify(result), idem.key);
        return result;
      })();
    } catch (e) {
      if (e instanceof IdempotentReplay) {
        // 标记重放（独立事务，即使失败也不影响回放）
        this.db.prepare(`UPDATE action_idempotency SET replayed = 1 WHERE idem_key = ?`).run(idem.key);
        throw e;
      }
      // 占位期唯一冲突（跨进程并发）：回放已存结果
      if (isUniqueViolation(e)) {
        const raced = this.db.prepare(`SELECT response FROM action_idempotency WHERE idem_key = ?`).get(idem.key) as
          | { response: string }
          | undefined;
        if (raced && raced.response !== '') {
          this.db.prepare(`UPDATE action_idempotency SET replayed = 1 WHERE idem_key = ?`).run(idem.key);
          throw new IdempotentReplay(JSON.parse(raced.response));
        }
      }
      throw e;
    }
  }
}

/** 幂等重放走异常通道，保证事务内先写业务数据、后写幂等键的顺序不被污染。 */
export class IdempotentReplay extends Error {
  constructor(readonly payload: unknown) {
    super('idempotent_replay');
    this.name = 'IdempotentReplay';
  }
}

function extractRefId(result: unknown): string | null {
  if (typeof result !== 'object' || result === null) return null;
  const r = result as Record<string, unknown>;
  for (const key of ['executionId', 'incidentId', 'custodyEventId', 'verificationId']) {
    if (typeof r[key] === 'string') return r[key] as string;
  }
  return null;
}

function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE';
}
