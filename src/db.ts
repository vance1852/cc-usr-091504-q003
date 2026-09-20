import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { SqliteDB } from './sqlite.js';

export type DB = SqliteDB;

/**
 * 打开数据库并应用 schema。
 * 使用 WAL + busy_timeout 支持多进程/并发读写；外键强制开启。
 */
export function openDatabase(path: string): DB {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new SqliteDB(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

function migrate(db: DB): void {
  db.exec(`
  -- 家长（监护人）
  CREATE TABLE IF NOT EXISTS guardians (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    phone           TEXT NOT NULL,
    emergency_phone TEXT NOT NULL,           -- 紧急联系人电话
    emergency_note  TEXT,
    token           TEXT NOT NULL UNIQUE,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- 学生
  CREATE TABLE IF NOT EXISTS students (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    guardian_id TEXT NOT NULL REFERENCES guardians(id),
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- 校方人员
  CREATE TABLE IF NOT EXISTS staff (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    role            TEXT NOT NULL CHECK (role IN ('teacher','nurse','coordinator')),
    is_responsible  INTEGER NOT NULL DEFAULT 0,  -- 指定负责人（冲突时接收通知）
    token           TEXT NOT NULL UNIQUE,
    active          INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- 药品登记（家长提交的实物信息）
  CREATE TABLE IF NOT EXISTS medications (
    id                  TEXT PRIMARY KEY,
    student_id          TEXT NOT NULL REFERENCES students(id),
    guardian_id         TEXT NOT NULL REFERENCES guardians(id),
    package_code        TEXT NOT NULL,             -- 包装条码/扫码内容
    label_drug_name     TEXT NOT NULL,             -- 药盒标签：药品名称
    label_dose_text     TEXT NOT NULL,             -- 药盒标签：剂量
    label_manufacturer  TEXT,
    expiry_date         TEXT NOT NULL,             -- 有效期 YYYY-MM-DD
    storage_requirement TEXT NOT NULL CHECK (storage_requirement IN ('room_temp','refrigerated','cool_dark')),
    initial_quantity    REAL NOT NULL CHECK (initial_quantity > 0),
    current_quantity    REAL NOT NULL CHECK (current_quantity >= 0),
    quantity_unit       TEXT NOT NULL,
    package_state       TEXT NOT NULL DEFAULT 'intact' CHECK (package_state IN ('intact','damaged')),
    storage_state       TEXT NOT NULL DEFAULT 'unknown' CHECK (storage_state IN ('unknown','ok','breached')),
    status              TEXT NOT NULL CHECK (status IN
                          ('intake_pending','in_custody','frozen','returned','depleted')),
    freeze_reason       TEXT,                      -- 非空时表示冻结原因
    current_holder_id   TEXT REFERENCES staff(id), -- 当前保管人
    received_at         TEXT,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_medications_guardian ON medications(guardian_id);
  CREATE INDEX IF NOT EXISTS idx_medications_student ON medications(student_id);
  CREATE INDEX IF NOT EXISTS idx_medications_status ON medications(status);

  -- 书面指示（授权）版本：每次家长提交/变更产生新版本，旧版本被取代但永不删除
  CREATE TABLE IF NOT EXISTS authorizations (
    id              TEXT PRIMARY KEY,
    medication_id   TEXT NOT NULL REFERENCES medications(id),
    version         INTEGER NOT NULL,
    status          TEXT NOT NULL CHECK (status IN ('pending','active','superseded','expired')),
    drug_name       TEXT NOT NULL,
    form            TEXT NOT NULL,
    dose_text       TEXT NOT NULL,
    route           TEXT NOT NULL,
    scheduled_times TEXT NOT NULL,               -- JSON: ["16:30"]
    valid_from      TEXT NOT NULL,
    valid_until     TEXT NOT NULL,
    notes           TEXT,
    submitted_by    TEXT NOT NULL REFERENCES guardians(id),
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (medication_id, version)
  );
  CREATE INDEX IF NOT EXISTS idx_auth_med ON authorizations(medication_id);

  -- 双人核对记录（针对特定授权版本）
  CREATE TABLE IF NOT EXISTS verifications (
    id              TEXT PRIMARY KEY,
    medication_id   TEXT NOT NULL REFERENCES medications(id),
    auth_id         TEXT NOT NULL REFERENCES authorizations(id),
    auth_version    INTEGER NOT NULL,
    staff1_id       TEXT NOT NULL REFERENCES staff(id),
    staff2_id       TEXT NOT NULL REFERENCES staff(id),
    result          TEXT NOT NULL CHECK (result IN ('verified','conflict')),
    label_match     INTEGER NOT NULL,            -- 标签药品名/剂量与指示是否一致（服务端比对）
    package_intact  INTEGER NOT NULL,
    storage_met     INTEGER NOT NULL,
    conflict_detail TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK (staff1_id <> staff2_id)
  );
  CREATE INDEX IF NOT EXISTS idx_verif_med ON verifications(medication_id);

  -- 保管事件：接收 / 跨班交接 / 退回，构成完整交接链
  CREATE TABLE IF NOT EXISTS custody_events (
    id                TEXT PRIMARY KEY,
    medication_id     TEXT NOT NULL REFERENCES medications(id),
    type              TEXT NOT NULL CHECK (type IN ('receive','handoff','return')),
    from_staff_id     TEXT REFERENCES staff(id),
    to_staff_id       TEXT REFERENCES staff(id),
    quantity_at_event REAL NOT NULL,
    note              TEXT,
    actor_id          TEXT NOT NULL REFERENCES staff(id),
    created_at        TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_custody_med ON custody_events(medication_id);
  -- 每件药品只能有一次接收、一次退回（重复扫码不会产生第二次）
  CREATE UNIQUE INDEX IF NOT EXISTS idx_custody_one_receive
    ON custody_events(medication_id) WHERE type = 'receive';
  CREATE UNIQUE INDEX IF NOT EXISTS idx_custody_one_return
    ON custody_events(medication_id) WHERE type = 'return';

  -- 实际执行记录：一经确认不可删除/修改
  CREATE TABLE IF NOT EXISTS executions (
    id                 TEXT PRIMARY KEY,
    medication_id      TEXT NOT NULL REFERENCES medications(id),
    auth_id            TEXT NOT NULL REFERENCES authorizations(id),
    auth_version       INTEGER NOT NULL,
    scheduled_date     TEXT NOT NULL,            -- 计划日期 YYYY-MM-DD
    scheduled_time     TEXT NOT NULL,            -- 计划时点 HH:MM
    executed_by        TEXT NOT NULL REFERENCES staff(id),
    quantity_before    REAL NOT NULL,
    quantity_after     REAL NOT NULL,
    administered_qty   REAL NOT NULL CHECK (administered_qty > 0),
    occurred_at        TEXT NOT NULL,            -- 实际执行时间（离线补传可能早于入库时间）
    device_id          TEXT,
    backfilled         INTEGER NOT NULL DEFAULT 0,
    created_at         TEXT NOT NULL DEFAULT (datetime('now'))
  );
  -- 同一药品同一天同一计划时点只能执行一次（并发领取/重复扫码的硬约束）
  CREATE UNIQUE INDEX IF NOT EXISTS idx_exec_slot
    ON executions(medication_id, scheduled_date, scheduled_time);

  -- 差错/异常事件（漏执行、学生拒绝、误差等），只能追加
  CREATE TABLE IF NOT EXISTS incidents (
    id             TEXT PRIMARY KEY,
    medication_id  TEXT NOT NULL REFERENCES medications(id),
    auth_id        TEXT REFERENCES authorizations(id),
    auth_version   INTEGER,
    type           TEXT NOT NULL CHECK (type IN
                     ('missed_dose','student_refused','dose_deviation','package_damaged','storage_breach','other')),
    detail         TEXT,
    scheduled_date TEXT,
    scheduled_time TEXT,
    reported_by    TEXT NOT NULL REFERENCES staff(id),
    occurred_at    TEXT NOT NULL,
    device_id      TEXT,
    backfilled     INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_incidents_med ON incidents(medication_id);

  -- 执行记录与差错事件一经确认只能追加，禁止删除或修改（应用层无此方法，数据库层再兜底）
  CREATE TRIGGER IF NOT EXISTS trg_executions_no_delete
    BEFORE DELETE ON executions
  BEGIN
    SELECT RAISE(ABORT, 'executions 为追加式记录，不可删除');
  END;
  CREATE TRIGGER IF NOT EXISTS trg_executions_no_update
    BEFORE UPDATE ON executions
  BEGIN
    SELECT RAISE(ABORT, 'executions 为追加式记录，不可修改');
  END;
  CREATE TRIGGER IF NOT EXISTS trg_incidents_no_delete
    BEFORE DELETE ON incidents
  BEGIN
    SELECT RAISE(ABORT, 'incidents 为追加式记录，不可删除');
  END;
  CREATE TRIGGER IF NOT EXISTS trg_incidents_no_update
    BEFORE UPDATE ON incidents
  BEGIN
    SELECT RAISE(ABORT, 'incidents 为追加式记录，不可修改');
  END;

  -- 冻结/解冻事件（审计用）
  CREATE TABLE IF NOT EXISTS freeze_events (
    id            TEXT PRIMARY KEY,
    medication_id TEXT NOT NULL REFERENCES medications(id),
    action        TEXT NOT NULL CHECK (action IN ('freeze','unfreeze')),
    reason        TEXT,
    detail        TEXT,
    actor_kind    TEXT NOT NULL CHECK (actor_kind IN ('staff','guardian','system')),
    actor_id      TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_freeze_med ON freeze_events(medication_id);

  -- 通知（家长与指定负责人）
  CREATE TABLE IF NOT EXISTS notifications (
    id            TEXT PRIMARY KEY,
    medication_id TEXT NOT NULL REFERENCES medications(id),
    audience      TEXT NOT NULL CHECK (audience IN ('guardian','responsible_staff','both')),
    type          TEXT NOT NULL,
    title         TEXT NOT NULL,
    body          TEXT NOT NULL,
    read_at       TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_notif_med ON notifications(medication_id);

  -- 动作幂等：客户端扫码/补传生成的唯一键，服务端保存首次结果，重复请求直接回放
  CREATE TABLE IF NOT EXISTS action_idempotency (
    idem_key     TEXT PRIMARY KEY,              -- 通常为 device_id:client_event_id
    action_type  TEXT NOT NULL,
    medication_id TEXT NOT NULL,
    ref_id       TEXT NOT NULL,                  -- 首次动作产生的记录 id
    response     TEXT NOT NULL,                  -- 首次响应 JSON
    replayed     INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );
  `);
}
