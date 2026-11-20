-- 2026-11-20: impor katalog (spreadsheet) tidak lagi mengubah katalog langsung. Isi file menjadi draf kind
-- 'import' (satu per kode, payload = baris file, atau {delete:true} untuk barang yang hilang di impor
-- "ganti semua") yang menunggu ACC admin, per barang, sebagian, atau seluruh file. catalog_imports = satu
-- baris per unggahan; catalog_drafts.import_id menghubungkan drafnya. item_id 0 = barang baru, belum ada.
-- SQLite tidak bisa mengubah CHECK, jadi catalog_drafts dan stock_history dibangun ulang (data dan index
-- dipertahankan; tidak ada tabel lain yang mereferensikannya).
CREATE TABLE IF NOT EXISTS catalog_imports (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  source     TEXT NOT NULL DEFAULT '',
  mode       TEXT NOT NULL CHECK (mode IN ('merge', 'replace')),
  rows       INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE catalog_drafts_new (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id     INTEGER NOT NULL,
  code        TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('barcode', 'unit', 'edit', 'stock', 'import')),
  uom         TEXT NOT NULL DEFAULT '' COLLATE NOCASE,
  payload     TEXT NOT NULL,
  before      TEXT NOT NULL DEFAULT '{}',
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  note        TEXT NOT NULL DEFAULT '',
  created_by  INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_by INTEGER REFERENCES users(id),
  reviewed_at TEXT,
  import_id   INTEGER REFERENCES catalog_imports(id)
);
INSERT INTO catalog_drafts_new(id, item_id, code, kind, uom, payload, before, status, note, created_by, created_at, reviewed_by, reviewed_at)
  SELECT id, item_id, code, kind, uom, payload, before, status, note, created_by, created_at, reviewed_by, reviewed_at FROM catalog_drafts;
DROP TABLE catalog_drafts;
ALTER TABLE catalog_drafts_new RENAME TO catalog_drafts;
CREATE UNIQUE INDEX IF NOT EXISTS idx_catalog_drafts_pending ON catalog_drafts(code, kind, uom) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_catalog_drafts_status ON catalog_drafts(status, created_at);
CREATE INDEX IF NOT EXISTS idx_catalog_drafts_import ON catalog_drafts(import_id, status);

CREATE TABLE stock_history_new (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT NOT NULL,
  uom         TEXT NOT NULL DEFAULT '',
  qty_before  REAL NOT NULL,
  qty_after   REAL NOT NULL,
  source      TEXT NOT NULL CHECK (source IN ('draft_approved', 'draft_rejected', 'tarik', 'apply', 'kirim', 'import')),
  draft_id    INTEGER,
  filled_by   INTEGER REFERENCES users(id),
  approved_by INTEGER REFERENCES users(id),
  note        TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO stock_history_new(id, code, uom, qty_before, qty_after, source, draft_id, filled_by, approved_by, note, created_at)
  SELECT id, code, uom, qty_before, qty_after, source, draft_id, filled_by, approved_by, note, created_at FROM stock_history;
DROP TABLE stock_history;
ALTER TABLE stock_history_new RENAME TO stock_history;
CREATE INDEX IF NOT EXISTS idx_stock_history_code ON stock_history(code, id);
CREATE INDEX IF NOT EXISTS idx_stock_history_time ON stock_history(id);
