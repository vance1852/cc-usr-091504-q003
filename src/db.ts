import { createDatabase, type DB } from './sqlite';

export type { DB };

/**
 * 数据模型要点：
 * - custody_events / deviations 为追加式账本，触发器禁止 UPDATE/DELETE；
 * - 每个执行类事件携带 idempotency_key（唯一），重复扫码不会产生第二次动作；
 * - EXECUTE 事件按 (medication, scheduled_date, scheduled_slot) 部分唯一索引去重，
 *   即使客户端换了幂等键，同一时段也不可能执行两次；
 * - client_event_id 用于离线补传去重。
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id   TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('parent','staff','manager','auditor'))
);

CREATE TABLE IF NOT EXISTS students (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  class_name TEXT NOT NULL,
  parent_id  TEXT NOT NULL REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS medications (
  id                   TEXT PRIMARY KEY,
  student_id           TEXT NOT NULL REFERENCES students(id),
  drug_name            TEXT NOT NULL,
  drug_identity        TEXT NOT NULL,          -- 药品身份：规格/厂家/批号等
  expiry_date          TEXT NOT NULL,          -- 药品有效期 YYYY-MM-DD
  storage_condition    TEXT NOT NULL,          -- 保管条件（照录家长书面说明）
  quantity_total       INTEGER NOT NULL CHECK (quantity_total > 0),
  quantity_remaining   INTEGER NOT NULL CHECK (quantity_remaining >= 0),
  status               TEXT NOT NULL DEFAULT 'SUBMITTED'
                       CHECK (status IN ('SUBMITTED','RECEIVED','IN_CUSTODY','RETURNED')),
  current_custodian_id TEXT REFERENCES users(id),
  current_location     TEXT,
  version              INTEGER NOT NULL DEFAULT 0,   -- 乐观锁
  created_by           TEXT NOT NULL REFERENCES users(id),
  created_at           TEXT NOT NULL
);

-- 书面指示（授权）按版本管理，同一药品同一时间至多一个 CONFIRMED 版本
CREATE TABLE IF NOT EXISTS authorizations (
  id                      TEXT PRIMARY KEY,
  medication_id           TEXT NOT NULL REFERENCES medications(id),
  version                 INTEGER NOT NULL,
  written_instruction     TEXT NOT NULL,        -- 书面指示原文，系统照录不做医学解释
  dose_quantity           INTEGER NOT NULL CHECK (dose_quantity > 0),  -- 每次用量（家长书面申报单位）
  schedule_slots          TEXT NOT NULL,        -- JSON 数组 ["HH:MM", ...]
  valid_from              TEXT NOT NULL,
  valid_until             TEXT NOT NULL,
  emergency_contact_name  TEXT NOT NULL,
  emergency_contact_phone TEXT NOT NULL,
  status                  TEXT NOT NULL DEFAULT 'PENDING'
                          CHECK (status IN ('PENDING','CONFIRMED','SUPERSEDED')),
  submitted_by            TEXT NOT NULL REFERENCES users(id),
  confirmed_by            TEXT REFERENCES users(id),
  confirmed_at            TEXT,
  created_at              TEXT NOT NULL,
  UNIQUE (medication_id, version)
);

CREATE TABLE IF NOT EXISTS custody_events (
  seq                INTEGER PRIMARY KEY AUTOINCREMENT,
  id                 TEXT NOT NULL UNIQUE,
  medication_id      TEXT NOT NULL REFERENCES medications(id),
  type               TEXT NOT NULL
                     CHECK (type IN ('RECEIVE','DUAL_CHECK','HANDOVER','EXECUTE','RETURN')),
  actor_id           TEXT NOT NULL REFERENCES users(id),
  witness_id         TEXT REFERENCES users(id),        -- 双人核对第二人
  from_custodian_id  TEXT REFERENCES users(id),
  to_custodian_id    TEXT REFERENCES users(id),
  location           TEXT,
  quantity_before    INTEGER NOT NULL,
  quantity_after     INTEGER NOT NULL,
  authorization_id   TEXT REFERENCES authorizations(id), -- EXECUTE 所用授权版本（追溯锚点）
  scheduled_date     TEXT,
  scheduled_slot     TEXT,
  idempotency_key    TEXT NOT NULL UNIQUE,
  client_event_id    TEXT UNIQUE,                      -- 离线事件 ID
  occurred_at        TEXT NOT NULL,                    -- 事件实际发生时间（离线时早于记录时间）
  recorded_at        TEXT NOT NULL,                    -- 服务端入账时间
  note               TEXT
);

-- 同一药品同一时段至多一次执行（重复扫码/重试的第二道防线）
CREATE UNIQUE INDEX IF NOT EXISTS one_execution_per_slot
  ON custody_events (medication_id, scheduled_date, scheduled_slot)
  WHERE type = 'EXECUTE';

CREATE TABLE IF NOT EXISTS freezes (
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,
  id              TEXT NOT NULL UNIQUE,
  medication_id   TEXT NOT NULL REFERENCES medications(id),
  reason          TEXT NOT NULL
                  CHECK (reason IN ('INFO_CONFLICT','AUTH_EXPIRED','MEDICATION_EXPIRED','PACKAGE_DAMAGED','STORAGE_FAILURE')),
  detail          TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','RESOLVED')),
  raised_by       TEXT NOT NULL REFERENCES users(id),
  created_at      TEXT NOT NULL,
  resolved_by     TEXT REFERENCES users(id),
  resolved_at     TEXT,
  resolution_note TEXT
);

-- 差错事件：漏执行 / 学生拒绝 / 用量误差，只追加，不修改原执行记录
CREATE TABLE IF NOT EXISTS deviations (
  seq              INTEGER PRIMARY KEY AUTOINCREMENT,
  id               TEXT NOT NULL UNIQUE,
  medication_id    TEXT NOT NULL REFERENCES medications(id),
  type             TEXT NOT NULL CHECK (type IN ('MISSED','REFUSED','DOSE_ERROR')),
  related_event_id TEXT REFERENCES custody_events(id),
  scheduled_date   TEXT,
  scheduled_slot   TEXT,
  detail           TEXT NOT NULL,
  reported_by      TEXT NOT NULL REFERENCES users(id),
  client_event_id  TEXT UNIQUE,
  occurred_at      TEXT NOT NULL,
  recorded_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  seq           INTEGER PRIMARY KEY AUTOINCREMENT,
  id            TEXT NOT NULL UNIQUE,
  recipient_id  TEXT NOT NULL REFERENCES users(id),
  medication_id TEXT REFERENCES medications(id),
  kind          TEXT NOT NULL,
  message       TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

-- 执行记录与差错事件一经入账不可更改、不可删除（存储层强制）
CREATE TRIGGER IF NOT EXISTS custody_events_no_update
BEFORE UPDATE ON custody_events
BEGIN SELECT RAISE(ABORT, 'custody_events 为追加式账本，禁止修改'); END;

CREATE TRIGGER IF NOT EXISTS custody_events_no_delete
BEFORE DELETE ON custody_events
BEGIN SELECT RAISE(ABORT, 'custody_events 为追加式账本，禁止删除'); END;

CREATE TRIGGER IF NOT EXISTS deviations_no_update
BEFORE UPDATE ON deviations
BEGIN SELECT RAISE(ABORT, 'deviations 为追加式账本，禁止修改'); END;

CREATE TRIGGER IF NOT EXISTS deviations_no_delete
BEFORE DELETE ON deviations
BEGIN SELECT RAISE(ABORT, 'deviations 为追加式账本，禁止删除'); END;
`;

export function createDb(path: string = ':memory:'): DB {
  const db = createDatabase(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);
  return db;
}

/** 演示/测试用基础数据：角色覆盖家长、值班老师、负责人、审计 */
export function seed(db: DB): void {
  const users = db.prepare('INSERT OR IGNORE INTO users (id, name, role) VALUES (?, ?, ?)');
  const students = db.prepare('INSERT OR IGNORE INTO students (id, name, class_name, parent_id) VALUES (?, ?, ?, ?)');
  const tx = db.transaction(() => {
    users.run('u-parent-1', '张家长', 'parent');
    users.run('u-parent-2', '李家长', 'parent');
    users.run('u-staff-1', '陈老师', 'staff');
    users.run('u-staff-2', '刘老师', 'staff');
    users.run('u-staff-3', '周老师', 'staff');
    users.run('u-mgr-1', '王主任', 'manager');
    users.run('u-audit-1', '赵审计', 'auditor');
    students.run('stu-1', '小明', '三年级二班', 'u-parent-1');
    students.run('stu-2', '小红', '二年级一班', 'u-parent-2');
  });
  tx();
}
