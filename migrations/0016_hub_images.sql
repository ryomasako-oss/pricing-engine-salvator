-- Gambar utama per kode barang dari Data Hub Salvator (lihat shared/hubImages.ts).
-- Hanya nama berkas di /media/products Hub; browser memuatnya lewat proxy
-- /api/hub-media supaya kunci dan alamat Hub tidak perlu diketahui browser.
CREATE TABLE IF NOT EXISTS hub_images (
  code  TEXT PRIMARY KEY,
  thumb TEXT NOT NULL,
  image TEXT NOT NULL
);