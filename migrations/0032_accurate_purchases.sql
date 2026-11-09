-- 2026-11-09 (Ryoma): modal = harga di faktur pembelian (PI), not the goods receipt (RI).
-- When the PI has "Total termasuk pajak" ticked, the line price includes PPN and is divided by 1,11.
-- Same columns as accurate_receipt_lines so every cost reader only swaps the table name
-- (accurate/receipts.ts costKind); receipt_id/receipt_no hold the PI's id/number.
-- The switch is ACCURATE_COGS_SOURCE = "PI", flipped only after the first PI pass completes.

CREATE TABLE IF NOT EXISTS accurate_purchase_lines (
  entity           TEXT NOT NULL,
  receipt_id       INTEGER NOT NULL,           -- Accurate record id of the purchase invoice
  line_id          INTEGER NOT NULL,
  receipt_no       TEXT NOT NULL DEFAULT '',   -- e.g. PI.2026.10.00012
  trans_date       TEXT NOT NULL,
  item_code        TEXT NOT NULL,
  unit             TEXT NOT NULL DEFAULT '',
  quantity         REAL NOT NULL DEFAULT 0,
  unit_price       REAL NOT NULL DEFAULT 0,    -- before PPN: unit_price_gross / 1,11 when inclusive_tax
  unit_price_gross REAL NOT NULL DEFAULT 0,    -- as Accurate reports it
  inclusive_tax    INTEGER NOT NULL DEFAULT 0,
  synced_at        TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (entity, receipt_id, line_id)
);
CREATE INDEX IF NOT EXISTS idx_purchase_lines_item
  ON accurate_purchase_lines(entity, item_code, trans_date DESC, receipt_id DESC);

-- Same columns as accurate_receipt_state: one pass/cursor/sweep implementation (accurate/receipts.ts docStep).
CREATE TABLE IF NOT EXISTS accurate_purchase_state (
  entity             TEXT PRIMARY KEY,
  since_update       TEXT,
  max_update         TEXT,
  backfill_since     TEXT,
  page               INTEGER NOT NULL DEFAULT 1,
  row_idx            INTEGER NOT NULL DEFAULT 0,
  receipts_seen      INTEGER NOT NULL DEFAULT 0,
  pass_started_at    TEXT,
  last_pass_at       TEXT,
  last_error         TEXT,
  last_error_at      TEXT,
  locked_until       TEXT,
  passes_since_sweep INTEGER NOT NULL DEFAULT 0,
  sweep_page         INTEGER NOT NULL DEFAULT 1,
  sweep_ids          TEXT,
  last_sweep_at      TEXT
);
