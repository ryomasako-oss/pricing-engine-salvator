-- Stok pembanding = stok mandiri (pemilik, 2026-11-25 sore): buku stok sendiri di Pricing Engine, tidak terhubung ke
-- Accurate dan tidak mengubah stok produksi. Tempatnya per barang x gudang x pemilik (umum / pt / cv): di rak barang PT
-- dan CV belum bisa dibedakan, jadi gudang menghitung "umum"; pembagian ke PT atau CV dicatat di sini nanti.
-- Status baru 'recorded' = tercatat di stok mandiri saja; daftar "Belum masuk Accurate" dimatikan, jadi hitungan yang
-- masih 'open' ikut menjadi 'recorded'. SQLite tidak bisa mengubah CHECK, jadi tabel dibangun ulang (data tetap).
CREATE TABLE stock_counts_new (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id         INTEGER,
  code            TEXT NOT NULL,
  uom             TEXT NOT NULL DEFAULT '',
  warehouse       TEXT NOT NULL DEFAULT '',
  owner           TEXT NOT NULL DEFAULT 'umum' CHECK (owner IN ('umum', 'pt', 'cv')),
  counted         REAL NOT NULL,
  accurate_qty    REAL,
  accurate_source TEXT,
  counted_at      TEXT NOT NULL,
  counted_by      INTEGER REFERENCES users(id),
  approved_by     INTEGER REFERENCES users(id),
  approved_at     TEXT NOT NULL DEFAULT (datetime('now')),
  draft_id        INTEGER,
  status          TEXT NOT NULL DEFAULT 'recorded' CHECK (status IN ('recorded', 'open', 'entered', 'matched')),
  entered_at      TEXT,
  entered_by      INTEGER REFERENCES users(id),
  entered_how     TEXT,
  entered_ref     TEXT NOT NULL DEFAULT '',
  note            TEXT NOT NULL DEFAULT ''
);
INSERT INTO stock_counts_new(id, item_id, code, uom, warehouse, owner, counted, accurate_qty, accurate_source, counted_at, counted_by,
                             approved_by, approved_at, draft_id, status, entered_at, entered_by, entered_how, entered_ref, note)
  SELECT id, item_id, code, uom, warehouse, 'umum', counted, accurate_qty, accurate_source, counted_at, counted_by,
         approved_by, approved_at, draft_id, CASE status WHEN 'open' THEN 'recorded' ELSE status END, entered_at, entered_by, entered_how, entered_ref, note
    FROM stock_counts;
DROP TABLE stock_counts;
ALTER TABLE stock_counts_new RENAME TO stock_counts;
CREATE INDEX IF NOT EXISTS ix_stock_counts_code ON stock_counts(code, warehouse, owner, counted_at);
CREATE INDEX IF NOT EXISTS ix_stock_counts_open ON stock_counts(status, approved_at);
