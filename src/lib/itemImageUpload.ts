import { api } from "../api";

const FULL_SIDE = 1200;
const THUMB_SIDE = 128;

/** Perkecil gambar apa pun yang bisa dibuka browser (JPG, PNG, WebP, ...) menjadi WebP
 *  dengan sisi terpanjang `side`. Gagal bila browser tidak bisa menulis WebP. */
async function toWebp(file: File, side: number, quality: number): Promise<Blob> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const scale = Math.min(1, side / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, "image/webp", quality));
  if (!blob || blob.type !== "image/webp") throw new Error("Browser ini tidak bisa membuat gambar WebP.");
  return blob;
}

/** Ubah `file` menjadi gambar penuh + thumbnail WebP lalu kirim; menimpa gambar lama barang ini.
 *  Mengembalikan thumbnail untuk pratinjau lokal. */
export async function uploadItemImage(code: string, file: File): Promise<Blob> {
  const [full, thumb] = await Promise.all([toWebp(file, FULL_SIDE, 0.85), toWebp(file, THUMB_SIDE, 0.8)]);
  const form = new FormData();
  form.set("full", full, `${code}.webp`);
  form.set("thumb", thumb, `${code}-thumb.webp`);
  await api.upload(`/item-image/${encodeURIComponent(code)}`, form);
  return thumb;
}
