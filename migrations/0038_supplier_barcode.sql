-- 2026-11-17 (Ryoma): barcode dari merek/supplier, diisi orang gudang dari kemasan barangnya.
-- NULL = belum diisi. Satu barcode hanya untuk satu barang, supaya hasil scan tidak ambigu.
-- Impor katalog (ON CONFLICT DO UPDATE) tidak menyentuh kolom ini, jadi isiannya tetap ada.
ALTER TABLE catalog_items ADD COLUMN supplier_barcode TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_catalog_supplier_barcode ON catalog_items(supplier_barcode);
