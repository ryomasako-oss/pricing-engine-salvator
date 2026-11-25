-- Laporan barang duplikat dari Gudang. Tabel ini terpisah dari draf Gudang
-- yang sudah ada (perubahan stok/barcode/satuan) supaya antrean duplikat
-- tampil di tabnya sendiri dan tidak tercampur dengan antrean lama.
-- ACC hanya mencatat barang mana yang dipakai (kept_item_id); tidak ada
-- barang katalog yang dihapus oleh keputusan ini.
-- Tanpa REFERENCES catalog_items: katalog dihapus langsung (impor ganti, hapus semua) dan tabel lain juga
-- tidak mengunci catalog_items; kode dan nama disalin saat lapor supaya laporan tetap terbaca sesudah barang dihapus.
CREATE TABLE IF NOT EXISTS duplicate_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_a_id INTEGER NOT NULL,
  item_b_id INTEGER NOT NULL,
  item_a_code TEXT NOT NULL DEFAULT '',
  item_a_name TEXT NOT NULL DEFAULT '',
  item_b_code TEXT NOT NULL DEFAULT '',
  item_b_name TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'approved', 'rejected')),
  reported_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  kept_item_id INTEGER,
  decided_by INTEGER REFERENCES users(id),
  decided_at TEXT,
  decision_note TEXT NOT NULL DEFAULT '',
  CHECK (item_a_id < item_b_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_duplicate_reports_open_pair
  ON duplicate_reports(item_a_id, item_b_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS ix_duplicate_reports_status_created
  ON duplicate_reports(status, created_at);
