-- 2026-11-04 (Ryoma): sales invoices (Faktur Penjualan, "SI") from Accurate, the
-- last 12 months, for two things: the ceiling of a new quote line is the price
-- the client last paid, and the morning recap lists invoice lines sold below
-- the purchase price of the day (accurate/sales.ts, shared/salesBelowCost.ts).
--
-- Money is stored as Accurate sends it, not normalised: whether an inclusive-tax
-- invoice's salesAmount carries PPN is read at query time, so a wrong guess there
-- is a code fix, not a full resync.

CREATE TABLE IF NOT EXISTS accurate_sales_lines (
  entity         TEXT NOT NULL,              -- 'CV' | 'PT'
  invoice_id     INTEGER NOT NULL,           -- Accurate record id of the invoice
  line_id        INTEGER NOT NULL,           -- detail id, or the line's position
  invoice_no     TEXT NOT NULL DEFAULT '',   -- e.g. SI.2026.10.00297
  trans_date     TEXT NOT NULL,              -- YYYY-MM-DD
  customer_no    TEXT NOT NULL DEFAULT '',   -- Accurate customerNo, e.g. C.00030
  customer_name  TEXT NOT NULL DEFAULT '',
  item_code      TEXT NOT NULL,
  unit           TEXT NOT NULL DEFAULT '',   -- the invoice's unit, e.g. BOX
  unit_ratio     REAL NOT NULL DEFAULT 1,    -- base units in one `unit` (Accurate unitRatio)
  quantity       REAL NOT NULL DEFAULT 0,    -- in `unit`
  return_qty     REAL NOT NULL DEFAULT 0,    -- returned so far, in `unit`
  sales_amount   REAL NOT NULL DEFAULT 0,    -- line total after the item discount
  inclusive_tax  INTEGER NOT NULL DEFAULT 0, -- the invoice's prices include PPN
  tax_rate       REAL NOT NULL DEFAULT 0,    -- PPN % of the invoice (tax1Rate)
  cash_discount  REAL NOT NULL DEFAULT 0,    -- invoice-level discount, spread over sub_total
  sub_total      REAL NOT NULL DEFAULT 0,
  synced_at      TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (entity, invoice_id, line_id)
);
-- "Last price of item X (to customer Y)" reads one item's rows newest first.
CREATE INDEX IF NOT EXISTS idx_sales_lines_item
  ON accurate_sales_lines(entity, item_code, trans_date DESC, invoice_id DESC);
-- The recap reads only lines synced since the previous one.
CREATE INDEX IF NOT EXISTS idx_sales_lines_synced ON accurate_sales_lines(entity, synced_at);

-- Same columns as accurate_receipt_state: one pass/cursor/sweep implementation (accurate/receipts.ts docStep).
CREATE TABLE IF NOT EXISTS accurate_sales_state (
  entity             TEXT PRIMARY KEY,
  since_update       TEXT,
  max_update         TEXT,
  backfill_since     TEXT,
  page               INTEGER NOT NULL DEFAULT 1,
  row_idx            INTEGER NOT NULL DEFAULT 0,
  receipts_seen      INTEGER NOT NULL DEFAULT 0, -- invoices seen this pass (name shared with receipts)
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

-- Links an app client to its Accurate customer, for "the price this client last paid".
ALTER TABLE clients ADD COLUMN accurate_customer_no TEXT NOT NULL DEFAULT '';
