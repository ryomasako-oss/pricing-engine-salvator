-- Arsip barang (2026-11-25): barang duplikat yang kalah saat ACC Duplikat disembunyikan dari Katalog dan
-- pencarian, bukan dihapus (sinkron Accurate akan memasukkannya lagi). Dipulihkan lewat tombol Pulihkan.
-- accurate_off_*: ditandai manual "sudah dinonaktifkan di Accurate" (API Accurate tidak bisa menonaktifkan barang).
ALTER TABLE catalog_items ADD COLUMN archived_at TEXT;
ALTER TABLE catalog_items ADD COLUMN archived_by INTEGER;
ALTER TABLE catalog_items ADD COLUMN archived_note TEXT NOT NULL DEFAULT '';
ALTER TABLE catalog_items ADD COLUMN accurate_off_at TEXT;
ALTER TABLE catalog_items ADD COLUMN accurate_off_by INTEGER;
CREATE INDEX IF NOT EXISTS ix_catalog_items_archived ON catalog_items(archived_at) WHERE archived_at IS NOT NULL;
