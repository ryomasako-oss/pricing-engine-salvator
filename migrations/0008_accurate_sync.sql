-- 2026-10-06 (Ryoma): read-only sync from Accurate Online (API Token auth).
-- Accurate data for both entities (CV and PT) lands in these staging tables
-- first, untouched by catalog rules, so overlaps and dirty records (negative
-- stock, the same code with different names/prices across entities) can be
-- inspected before anything reaches catalog_items. Promotion into the
-- catalog is an explicit, per-entity step (POST /api/accurate/apply).

CREATE TABLE IF NOT EXISTS accurate_items (
  entity      TEXT NOT NULL,              -- 'CV' | 'PT'
  accurate_id INTEGER NOT NULL,           -- Accurate record id
  code        TEXT NOT NULL,              -- Accurate "no" (kode barang)
  name        TEXT NOT NULL DEFAULT '',
  item_type   TEXT NOT NULL DEFAULT '',
  uom         TEXT NOT NULL DEFAULT '',   -- unit1 (base unit)
  unit_price  REAL NOT NULL DEFAULT 0,    -- default selling price per unit1
  units       TEXT NOT NULL DEFAULT '[]', -- JSON [{uom, factor}] from unit2..5 / ratio2..5
  category    TEXT NOT NULL DEFAULT '',
  suspended   INTEGER NOT NULL DEFAULT 0,
  run_id      TEXT NOT NULL,              -- sync run that last saw this row
  synced_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (entity, accurate_id)
);
CREATE INDEX IF NOT EXISTS idx_accurate_items_code ON accurate_items(code);
CREATE INDEX IF NOT EXISTS idx_accurate_items_entity_code ON accurate_items(entity, code);

CREATE TABLE IF NOT EXISTS accurate_warehouses (
  entity      TEXT NOT NULL,
  accurate_id INTEGER NOT NULL,
  name        TEXT NOT NULL DEFAULT '',
  run_id      TEXT NOT NULL,
  PRIMARY KEY (entity, accurate_id)
);

CREATE TABLE IF NOT EXISTS accurate_stock (
  entity       TEXT NOT NULL,
  warehouse_id INTEGER NOT NULL,
  item_code    TEXT NOT NULL,
  quantity     REAL NOT NULL DEFAULT 0,
  run_id       TEXT NOT NULL,
  synced_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (entity, warehouse_id, item_code)
);
CREATE INDEX IF NOT EXISTS idx_accurate_stock_item ON accurate_stock(entity, item_code);

-- One row per entity: a resumable cursor, so a full pull of ~30k SKUs is
-- spread over many short cron ticks instead of one long request.
CREATE TABLE IF NOT EXISTS accurate_sync_state (
  entity          TEXT PRIMARY KEY,
  host            TEXT,                     -- from /api/api-token.do
  host_checked_at TEXT,
  db_alias        TEXT,
  run_id          TEXT,
  phase           TEXT NOT NULL DEFAULT 'idle', -- idle | items | warehouses | stock
  page            INTEGER NOT NULL DEFAULT 1,
  warehouse_idx   INTEGER NOT NULL DEFAULT 0,
  items_seen      INTEGER NOT NULL DEFAULT 0,
  stock_rows      INTEGER NOT NULL DEFAULT 0,
  started_at      TEXT,
  last_success_at TEXT,                     -- when the last full run finished
  last_error      TEXT,
  last_error_at   TEXT,
  locked_until    TEXT,
  force_restart   INTEGER NOT NULL DEFAULT 0
);
