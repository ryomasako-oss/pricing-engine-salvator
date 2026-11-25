-- Laporan duplikat per kelompok: 3-4 barang kembar dicentang bersama di Katalog jadi satu kelompok
-- (satu baris per pasangan acuan-kembaran, group_key sama). Admin memutuskan sekelompok sekaligus.
-- Baris lama tanpa group_key diperlakukan sebagai kelompok sendiri.
ALTER TABLE duplicate_reports ADD COLUMN group_key TEXT;
CREATE INDEX IF NOT EXISTS ix_duplicate_reports_group ON duplicate_reports(group_key);
