-- 2026-10-15 (Ryoma): COGS = harga pembelian terakhir, the unit price on an
-- item's latest goods receipt (Penerimaan Barang) in Accurate, not the
-- period average from the Nilai Persediaan report (shared/lastPurchaseCost.ts).
--
-- Receipt lines are history, pulled incrementally by Accurate's lastUpdate,
-- so unlike accurate_items/accurate_stock they are never pruned by run_id.
-- Numbered 0017: 0016 is taken by feat/hub-images (PR #32); the two are
-- independent and wrangler applies unapplied migrations by name.

CREATE TABLE IF NOT EXISTS accurate_receipt_lines (
  entity      TEXT NOT NULL,              -- 'CV' | 'PT'
  receipt_id  INTEGER NOT NULL,           -- Accurate record id of the receipt
  line_id     INTEGER NOT NULL,           -- detail id, or the line's position
  receipt_no  TEXT NOT NULL DEFAULT '',   -- e.g. RI.2026.05.00022
  trans_date  TEXT NOT NULL,              -- YYYY-MM-DD
  item_code   TEXT NOT NULL,
  unit        TEXT NOT NULL DEFAULT '',
  quantity    REAL NOT NULL DEFAULT 0,
  unit_price  REAL NOT NULL DEFAULT 0,    -- as Accurate reports it, per `unit`
  synced_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (entity, receipt_id, line_id)
);
-- "Latest receipt of item X" reads one item's rows newest first.
CREATE INDEX IF NOT EXISTS idx_receipt_lines_item
  ON accurate_receipt_lines(entity, item_code, trans_date DESC, receipt_id DESC);

-- Receipts have their own cursor, separate from the item/stock run.
CREATE TABLE IF NOT EXISTS accurate_receipt_state (
  entity          TEXT PRIMARY KEY,
  since_update    TEXT,                     -- Accurate lastUpdate (dd/MM/yyyy HH:mm:ss) this pass starts from
  max_update      TEXT,                     -- highest lastUpdate seen in this pass
  backfill_since  TEXT,                     -- first pass: transDate start (dd/MM/yyyy), fixed when the pass starts
  page            INTEGER NOT NULL DEFAULT 1,
  row_idx         INTEGER NOT NULL DEFAULT 0, -- next row of `page` whose detail is still to fetch
  receipts_seen   INTEGER NOT NULL DEFAULT 0,
  pass_started_at TEXT,
  last_pass_at    TEXT,                     -- when the last full pass finished
  last_error      TEXT,
  last_error_at   TEXT,
  locked_until    TEXT
);
