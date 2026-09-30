'use strict';
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(__dirname, '..', 'data', 'allergen.db');

let db;

function getDb() {
  if (db) return db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initSchema(db);
  return db;
}

function initDbFile() {
  const d = getDb();
  return d;
}

function initSchema(d) {
  d.exec(`
  CREATE TABLE IF NOT EXISTS materials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    allergens TEXT NOT NULL DEFAULT '[]'  -- JSON 字符串数组
  );

  CREATE TABLE IF NOT EXISTS equipment (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_time TEXT NOT NULL,          -- ISO 字符串，如 2026-09-30T08:00
    type TEXT NOT NULL CHECK (type IN ('PROCESS','CLEAN')),
    equipment_id INTEGER NOT NULL REFERENCES equipment(id),
    batch_id INTEGER UNIQUE REFERENCES batches(id), -- PROCESS 时唯一
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE
  );

  CREATE TABLE IF NOT EXISTS process_inputs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    material_id INTEGER REFERENCES materials(id),
    batch_id INTEGER REFERENCES batches(id),
    CHECK ((material_id IS NOT NULL AND batch_id IS NULL)
        OR (material_id IS NULL AND batch_id IS NOT NULL))
  );

  -- 重算结果（派生数据，随事件变更全量刷新）
  CREATE TABLE IF NOT EXISTS batch_outputs (
    batch_id INTEGER PRIMARY KEY REFERENCES batches(id) ON DELETE CASCADE,
    allergens TEXT NOT NULL DEFAULT '[]',
    paths_json TEXT NOT NULL DEFAULT '[]'
  );

  -- 设备当前残留（最后一次已核实清洗之后的累积）
  CREATE TABLE IF NOT EXISTS equipment_residue (
    equipment_id INTEGER PRIMARY KEY REFERENCES equipment(id) ON DELETE CASCADE,
    allergens TEXT NOT NULL DEFAULT '[]',
    paths_json TEXT NOT NULL DEFAULT '[]',
    last_cleaned_at TEXT
  );

  CREATE TABLE IF NOT EXISTS releases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id INTEGER NOT NULL REFERENCES batches(id),
    released_at TEXT NOT NULL,
    released_by TEXT NOT NULL DEFAULT '',
    snapshot_allergens TEXT NOT NULL DEFAULT '[]',  -- 登记当时的过敏原集合（排序）
    status TEXT NOT NULL CHECK (status IN ('ACTIVE','INVALIDATED')),
    invalid_reason TEXT NOT NULL DEFAULT '',
    created_event_seq INTEGER NOT NULL DEFAULT 0  -- 登记时的事件版本号
  );

  -- 过敏原标签卷（包装前按“批次 + 有效放行”登记；停用为终态，不自动恢复）
  CREATE TABLE IF NOT EXISTS label_rolls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    roll_code TEXT NOT NULL UNIQUE,               -- 卷号，如 LR-0001
    batch_id INTEGER NOT NULL REFERENCES batches(id),
    release_id INTEGER REFERENCES releases(id) ON DELETE SET NULL, -- 绑定的放行快照；放行删除时置空
    allergens TEXT NOT NULL DEFAULT '[]',         -- 拟印过敏原集合（排序快照，登记时三重一致）
    printed_qty INTEGER NOT NULL,                 -- 印量（正整数）
    used_qty INTEGER NOT NULL DEFAULT 0,          -- 累计贴用
    void_qty INTEGER NOT NULL DEFAULT 0,          -- 累计作废
    status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DEACTIVATED')),
    review_pending INTEGER NOT NULL DEFAULT 0,    -- 停用后已贴数量标记待复核（1=待复核）
    revision INTEGER NOT NULL DEFAULT 1,          -- 核销预期修订号（每次成功核销 +1）
    registered_at TEXT NOT NULL,
    registered_by TEXT NOT NULL DEFAULT '',
    deactivated_at TEXT,
    deactivate_reason TEXT NOT NULL DEFAULT '',
    CHECK (printed_qty > 0 AND used_qty >= 0 AND void_qty >= 0
           AND used_qty + void_qty <= printed_qty)
  );

  -- 标签卷核销流水（贴用/作废逐笔留痕，修订号递增可审计）
  CREATE TABLE IF NOT EXISTS label_roll_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    roll_id INTEGER NOT NULL REFERENCES label_rolls(id) ON DELETE CASCADE,
    applied_delta INTEGER NOT NULL DEFAULT 0,
    void_delta INTEGER NOT NULL DEFAULT 0,
    revision_after INTEGER NOT NULL,              -- 本笔核销后的修订号
    operated_by TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_events_time ON events(event_time, id);
  CREATE INDEX IF NOT EXISTS idx_process_inputs_event ON process_inputs(event_id);
  CREATE INDEX IF NOT EXISTS idx_releases_batch ON releases(batch_id);
  CREATE INDEX IF NOT EXISTS idx_label_rolls_batch ON label_rolls(batch_id);
  CREATE INDEX IF NOT EXISTS idx_label_rolls_release ON label_rolls(release_id);
  CREATE INDEX IF NOT EXISTS idx_label_roll_ledger_roll ON label_roll_ledger(roll_id);
  `);
}

module.exports = { getDb, initDbFile, initSchema, DB_PATH };
