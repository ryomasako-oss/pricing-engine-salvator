/* Salin gambar barang dari folder mana pun ke folder gambar yang dilayani server.
 *
 *   npm run import:images -- /path/ke/folder/gambar
 *
 * Nama berkas harus persis mengikuti kode barang, jadi tidak perlu rename:
 *   <kode>.webp         gambar penuh
 *   <kode>-thumb.webp   thumbnail (opsional; tanpa ini route memakai gambar penuh)
 *
 * Berkas yang namanya tidak cocok pola dilewati dan dilaporkan, bukan diam-diam
 * dibuang: nama yang keliru biasanya berarti kode katalognya juga keliru.
 *
 * Skrip ini hanya mengisi folder lokal. Bucket R2 di Worker belum punya pengirim
 * massal; sampai itu ada, isi R2 dari mesin yang punya gambar lewat wrangler. */

import fs from "node:fs";
import path from "node:path";
import { ITEM_IMAGE_FILE } from "../shared/itemImages.js";

const src = process.argv[2];
const dest = path.resolve(process.env.IMAGES_DIR || "./data/images");

if (!src) {
  console.error("Pemakaian: npm run import:images -- <folder gambar>");
  process.exit(1);
}
if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) {
  console.error(`Folder tidak ditemukan: ${src}`);
  process.exit(1);
}

const names = fs.readdirSync(src);
const accepted: string[] = [];
const skipped: string[] = [];
for (const name of names) {
  if (!fs.statSync(path.join(src, name)).isFile()) continue;
  (ITEM_IMAGE_FILE.test(name) && !name.includes("..") ? accepted : skipped).push(name);
}

fs.mkdirSync(dest, { recursive: true });
let copied = 0;
for (const name of accepted) {
  const to = path.join(dest, name);
  // Skip yang isinya sudah sama, supaya impor ulang tidak menyentuh semua berkas.
  const same =
    fs.existsSync(to) && fs.statSync(to).size === fs.statSync(path.join(src, name)).size && fs.statSync(to).mtimeMs >= fs.statSync(path.join(src, name)).mtimeMs;
  if (same) continue;
  fs.copyFileSync(path.join(src, name), to);
  copied++;
}

const codes = new Set(accepted.map((name) => name.replace(/-thumb\.webp$/, "").replace(/\.webp$/, "")));
console.log(`Sumber      : ${path.resolve(src)}`);
console.log(`Tujuan      : ${dest}`);
console.log(`Disalin     : ${copied} berkas (${accepted.length - copied} sudah sama)`);
console.log(`Kode unik   : ${codes.size}`);
if (skipped.length) {
  console.log(`\nDilewati ${skipped.length} berkas (namanya bukan <kode>.webp / <kode>-thumb.webp):`);
  for (const name of skipped.slice(0, 20)) console.log(`  ${name}`);
  if (skipped.length > 20) console.log(`  ... dan ${skipped.length - 20} lagi`);
}
console.log("\nBuka katalog sekali supaya daftar kode ikut diperbarui (maks 30 menit kemudian).");