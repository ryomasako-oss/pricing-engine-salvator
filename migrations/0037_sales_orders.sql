-- 0037_sales_orders.sql: Pipeline Quotation Disetujui -> Sales Order -> FMS Salvator

CREATE TABLE IF NOT EXISTS sales_orders (
  id              TEXT PRIMARY KEY,
  order_no        TEXT NOT NULL UNIQUE,
  quote_id        INTEGER NOT NULL REFERENCES quotes(id),
  quote_number    TEXT NOT NULL,
  client_code     TEXT NOT NULL,
  client_name     TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'DRAFT',
  items_json      TEXT NOT NULL,
  shipping_json   TEXT NOT NULL,
  tracking_no     TEXT,
  courier_code    TEXT,
  total_amount    REAL NOT NULL DEFAULT 0,
  created_by      INTEGER NOT NULL REFERENCES users(id),
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  confirmed_at    TEXT,
  shipped_at      TEXT,
  cancelled_at    TEXT,
  cancel_reason   TEXT
);

CREATE INDEX IF NOT EXISTS idx_so_quote_id ON sales_orders(quote_id);
CREATE INDEX IF NOT EXISTS idx_so_status ON sales_orders(status);
CREATE INDEX IF NOT EXISTS idx_so_client_code ON sales_orders(client_code);
CREATE INDEX IF NOT EXISTS idx_so_created_at ON sales_orders(created_at);

CREATE TABLE IF NOT EXISTS sales_order_events (
  id            TEXT PRIMARY KEY,
  order_no      TEXT NOT NULL,
  event_type    TEXT NOT NULL,
  payload_json  TEXT NOT NULL,
  actor         TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_so_events_order ON sales_order_events(order_no, created_at);

CREATE TABLE IF NOT EXISTS so_outbox (
  id              TEXT PRIMARY KEY,
  event_id        TEXT NOT NULL UNIQUE,
  event_type      TEXT NOT NULL,
  payload_json    TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'PENDING',
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_error      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  delivered_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_so_outbox_pending ON so_outbox(next_attempt_at) WHERE status = 'PENDING';

CREATE TABLE IF NOT EXISTS fms_inbox (
  id            TEXT PRIMARY KEY,
  event_id      TEXT NOT NULL UNIQUE,
  event_type    TEXT NOT NULL,
  payload_json  TEXT NOT NULL,
  processed_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO settings (key, value) VALUES ('sales_order_enabled', '0');
