-- 2026-11-17: Sales Order dari quotation dan integrasi FMS Salvator
-- (docs/integrasi-pe-fms.md). Quotation approved/sent/won -> "Jadikan SO" ->
-- outbox ke FMS; FMS mengirim balik posisi gudang.

CREATE TABLE IF NOT EXISTS sales_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  number TEXT NOT NULL UNIQUE,                 -- HK/SIP/SO/YYMM/NNN
  quote_id INTEGER NOT NULL REFERENCES quotes(id),
  quote_rev_no INTEGER NOT NULL,
  client_id INTEGER REFERENCES clients(id),
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','cancel_requested','cancelled','shipped')),
  sync_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (sync_state IN ('pending','delivered','failed')),
  sync_error TEXT,
  fulfillment_state TEXT
    CHECK (fulfillment_state IN ('queued','packing','on_hold','packed','shipped','cancelled')),
  fulfillment_reason TEXT,
  fms_outbound_ref TEXT,
  last_fms_sequence INTEGER NOT NULL DEFAULT 0,
  customer_po_number TEXT,
  ship_to_name TEXT NOT NULL,
  ship_to_phone TEXT,
  ship_to_address TEXT NOT NULL,
  requested_date TEXT,
  note TEXT,
  lines TEXT NOT NULL,                         -- JSON snapshot, termasuk harga skenario terpilih (tanpa COGS)
  total_value REAL NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Satu SO aktif per quotation.
CREATE UNIQUE INDEX IF NOT EXISTS sales_orders_one_active
  ON sales_orders(quote_id) WHERE status <> 'cancelled';

CREATE TABLE IF NOT EXISTS sales_order_events (           -- linimasa di halaman SO
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sales_order_id INTEGER NOT NULL REFERENCES sales_orders(id),
  kind TEXT NOT NULL,                          -- created, sent, fms_state, cancel_requested, cancel_rejected, sync_failed, resend
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS sales_order_events_so ON sales_order_events(sales_order_id);

CREATE TABLE IF NOT EXISTS so_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  sales_order_id INTEGER NOT NULL REFERENCES sales_orders(id),
  type TEXT NOT NULL,
  body TEXT NOT NULL,                          -- amplop lengkap, ditandatangani saat kirim
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_error TEXT,
  parked INTEGER NOT NULL DEFAULT 0,
  delivered_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS so_outbox_pending ON so_outbox(next_attempt_at) WHERE delivered_at IS NULL AND parked = 0;

CREATE TABLE IF NOT EXISTS fms_inbox (                       -- idempoten event dari FMS
  event_id TEXT PRIMARY KEY,
  -- Ack pertama, dikirim ulang apa adanya untuk eventId yang sama (kontrak bagian 3).
  result TEXT,
  received_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Saklar fitur: mati sampai pemilik menguji alur nyata. Baris hilang juga dianggap mati.
INSERT OR IGNORE INTO settings (key, value) VALUES ('sales_order_enabled', '0');

-- F4b: FMS menarik klien yang berubah sejak sinkron terakhir.
ALTER TABLE clients ADD COLUMN updated_at TEXT;
UPDATE clients SET updated_at = created_at;
