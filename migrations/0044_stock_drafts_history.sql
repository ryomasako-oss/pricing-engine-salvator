-- 2026-11-20: stok katalog hanya berubah lewat tombol Tarik, "Terapkan ke katalog", atau draf stok yang di-ACC
-- admin (bukan lagi otomatis tiap sinkron Accurate). Draf stok = catalog_drafts kind 'stock'
-- (payload {stock}, before {stock}, uom '' = satuan dasar). Setiap perubahan dicatat di stock_history.
-- SQLite tidak bisa mengubah CHECK, jadi catalog_drafts dibangun ulang (data dan index dipertahankan;
-- tidak ada tabel lain yang mereferensikannya).
CREATE TABLE catalog_drafts_new (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id     INTEGER NOT NULL,
  code        TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('barcode', 'unit', 'edit', 'stock')),
  uom         TEXT NOT NULL DEFAULT '' COLLATE NOCASE,
  payload     TEXT NOT NULL,
  before      TEXT NOT NULL DEFAULT '{}',
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  note        TEXT NOT NULL DEFAULT '',
  created_by  INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_by INTEGER REFERENCES users(id),
  reviewed_at TEXT
);
INSERT INTO catalog_drafts_new(id, item_id, code, kind, uom, payload, before, status, note, created_by, created_at, reviewed_by, reviewed_at)
  SELECT id, item_id, code, kind, uom, payload, before, status, note, created_by, created_at, reviewed_by, reviewed_at FROM catalog_drafts;
DROP TABLE catalog_drafts;
ALTER TABLE catalog_drafts_new RENAME TO catalog_drafts;
CREATE UNIQUE INDEX IF NOT EXISTS idx_catalog_drafts_pending ON catalog_drafts(code, kind, uom) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_catalog_drafts_status ON catalog_drafts(status, created_at);

-- Riwayat stok per barang. source: draft_approved | draft_rejected | tarik | apply | kirim (nanti).
-- Untuk draft_rejected, qty_after = angka yang diusulkan (stok tidak berubah). filled_by = pembuat draf
-- atau penekan tombol Tarik / Terapkan; approved_by = admin yang meng-ACC atau menolak.
CREATE TABLE IF NOT EXISTS stock_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT NOT NULL,
  uom         TEXT NOT NULL DEFAULT '',
  qty_before  REAL NOT NULL,
  qty_after   REAL NOT NULL,
  source      TEXT NOT NULL CHECK (source IN ('draft_approved', 'draft_rejected', 'tarik', 'apply', 'kirim')),
  draft_id    INTEGER,
  filled_by   INTEGER REFERENCES users(id),
  approved_by INTEGER REFERENCES users(id),
  note        TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_stock_history_code ON stock_history(code, id);
CREATE INDEX IF NOT EXISTS idx_stock_history_time ON stock_history(id);

-- Barang yang stoknya sudah di-ACC tetapi belum terkirim ke Accurate: Tarik dan Terapkan melewatinya.
CREATE TABLE IF NOT EXISTS stock_unsent (
  code  TEXT PRIMARY KEY COLLATE NOCASE,
  since TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO settings(key, value) VALUES ('stock_push_enabled', '0');
