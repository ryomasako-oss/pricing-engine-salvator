-- 2026-11-17 (Ryoma): Stock UOM Adjustment. Rasio satuan yang diisi di aplikasi untuk barang yang satuan
-- SI dan PI-nya beda (misalnya 1 PAK = 5 KG), supaya harga jual dan beli dibandingkan per satuan dasar
-- yang sama. Menang atas rasio Accurate; Accurate sendiri tidak diubah. Sinkron Accurate tidak menyentuh
-- tabel ini. Hapus barisnya untuk kembali ke rasio Accurate.
CREATE TABLE IF NOT EXISTS uom_adjustments (
  entity     TEXT NOT NULL,
  code       TEXT NOT NULL,
  uom        TEXT NOT NULL COLLATE NOCASE,
  factor     REAL NOT NULL CHECK (factor > 0),
  note       TEXT NOT NULL DEFAULT '',
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (entity, code, uom)
);
