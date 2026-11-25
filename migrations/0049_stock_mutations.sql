-- Riwayat mutasi stok dari Accurate (2026-11-25). item/stock-mutation-history.do hanya memberi 7 hari terakhir,
-- jadi aplikasi menariknya rutin dan menyimpannya sendiri: satu baris per gerakan stok per barang per gudang.
-- Dasar "stok pembanding" (cycle count + mutasi sesudahnya) dan pelacakan stok minus.
-- Transaksi yang dihapus di Accurate tidak dihapus di sini: removed_at diisi, supaya jejaknya tetap terbaca.
CREATE TABLE IF NOT EXISTS stock_mutations (
  entity        TEXT NOT NULL,
  accurate_id   INTEGER NOT NULL,
  item_no       TEXT NOT NULL,
  warehouse     TEXT NOT NULL DEFAULT '',
  trans_type    TEXT NOT NULL DEFAULT '',
  trans_number  TEXT NOT NULL DEFAULT '',
  trans_id      INTEGER,
  trans_date    TEXT,              -- YYYY-MM-DD (tanggal transaksi di Accurate)
  created_wib   TEXT,              -- YYYY-MM-DD HH:MM:SS WIB (kapan dibuat di Accurate)
  qty           REAL NOT NULL,     -- + masuk, - keluar, satuan dasar barang di Accurate
  item_cost     REAL,
  fetched_at    TEXT NOT NULL DEFAULT (datetime('now')),
  seen_pass     TEXT,
  removed_at    TEXT,
  PRIMARY KEY (entity, accurate_id)
);
CREATE INDEX IF NOT EXISTS ix_stock_mutations_item ON stock_mutations(entity, item_no, warehouse, created_wib);
CREATE INDEX IF NOT EXISTS ix_stock_mutations_created ON stock_mutations(entity, created_wib);

CREATE TABLE IF NOT EXISTS accurate_mutation_state (
  entity          TEXT PRIMARY KEY,
  pass_id         TEXT,
  page            INTEGER NOT NULL DEFAULT 1,
  rows_seen       INTEGER NOT NULL DEFAULT 0,
  last_pass_at    TEXT,
  last_error      TEXT,
  last_error_at   TEXT,
  locked_until    TEXT
);
