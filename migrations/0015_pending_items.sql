-- 2026-10-08 (Ryoma): a barang baru is held in the pricing engine first and
-- only then handed to Accurate. A pending item is a proposed code + name that
-- quote lines can already point at (the lines are held as "menunggu Accurate",
-- see shared/pendingItems.ts); it stops being pending as soon as the catalog
-- has that code, which is how the item arrives once it exists in Accurate and
-- has been applied.
--   draft      requested (usually by sales), not yet handed to Accurate
--   submitted  a manager handed it over: an open "Barang baru ke Accurate" task
--   linked     the catalog has the code now
--   cancelled  nobody needs it any more

CREATE TABLE IF NOT EXISTS pending_items (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  code           TEXT NOT NULL,
  name           TEXT NOT NULL,
  uom            TEXT NOT NULL DEFAULT 'Pcs',
  proposed_price REAL NOT NULL DEFAULT 0,
  note           TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'draft',
  requested_by   INTEGER REFERENCES users(id),
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  submitted_by   INTEGER REFERENCES users(id),
  submitted_at   TEXT,
  linked_at      TEXT
);
-- One live request per code, however it is spelled.
CREATE UNIQUE INDEX IF NOT EXISTS ux_pending_items_live_code
  ON pending_items(lower(trim(code))) WHERE status IN ('draft', 'submitted');
CREATE INDEX IF NOT EXISTS idx_pending_items_status ON pending_items(status, created_at);
