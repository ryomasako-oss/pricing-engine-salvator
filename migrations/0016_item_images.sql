-- Kode barang yang punya gambar di storage sendiri (lihat shared/itemImages.ts).
-- Yang disimpan hanya daftar kodenya; byte gambarnya ada di folder IMAGES_DIR
-- (Node) atau bucket R2 (Workers), bernama <kode>.webp / <kode>-thumb.webp.
CREATE TABLE IF NOT EXISTS item_images (
  code TEXT PRIMARY KEY
);
