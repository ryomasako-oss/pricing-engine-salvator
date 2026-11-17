-- 2026-11-17 (Ryoma): barcode per satuan (SKU = barang + satuan). Pcs, Box, dan Dus satu barang
-- punya barcode sendiri-sendiri, karena kemasannya memang beda barcode.
-- Tabel sendiri, bukan kolom di catalog_item_uoms: sinkron Accurate menghapus dan mengisi ulang
-- tabel rasio itu, dan barcode isian gudang tidak boleh ikut hilang. Baris di sini juga sengaja
-- tidak ikut dihapus saat katalog diganti total: begitu barangnya kembali, barcodenya kembali.
-- generated = 1: nomor EAN-13 buatan sistem (awalan 20, kode untuk barang toko sendiri).
CREATE TABLE IF NOT EXISTS catalog_unit_barcodes (
  code       TEXT NOT NULL,
  uom        TEXT NOT NULL COLLATE NOCASE,
  barcode    TEXT NOT NULL UNIQUE,
  generated  INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (code, uom)
);

-- Barcode yang sudah diisi lewat kolom lama (0038) menjadi barcode satuan dasar barang itu.
-- Kolom catalog_items.supplier_barcode dibiarkan sebagai cadangan, tetapi tidak dibaca lagi.
INSERT OR IGNORE INTO catalog_unit_barcodes(code, uom, barcode)
  SELECT code, uom, supplier_barcode FROM catalog_items
   WHERE supplier_barcode IS NOT NULL AND supplier_barcode <> '';

-- Satuan yang ditambah manual di aplikasi (gudang, atau manager lewat Edit barang) diberi tanda,
-- supaya "Terapkan" Accurate tidak menghapusnya. Bila Accurate kelak punya satuan yang sama,
-- baris Accurate menggantikannya (INSERT OR REPLACE mengisi ulang manual = 0).
ALTER TABLE catalog_item_uoms ADD COLUMN manual INTEGER NOT NULL DEFAULT 0;
-- Satuan katalog yang sekarang tidak ada di data Accurate hanya bisa berasal dari isian manual.
UPDATE catalog_item_uoms SET manual = 1
 WHERE NOT EXISTS (
   SELECT 1 FROM accurate_items a, json_each(a.units) j
    WHERE a.code = catalog_item_uoms.code AND lower(json_extract(j.value, '$.uom')) = lower(catalog_item_uoms.uom));

-- Satuan usulan gudang (mis. 1 Lusin = 12 Pcs). Quotation tidak memakainya: quotation hanya membaca
-- catalog_item_uoms. Manager menyetujui (baris pindah ke catalog_item_uoms, manual = 1) atau menolak
-- (baris dan barcodenya dihapus). Riwayatnya ada di audit_log.
CREATE TABLE IF NOT EXISTS catalog_unit_proposals (
  code        TEXT NOT NULL,
  uom         TEXT NOT NULL COLLATE NOCASE,
  factor      REAL NOT NULL CHECK (factor > 0),
  proposed_by INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (code, uom)
);
