/* /api/item-image — gambar barang di bucket R2 (binding IMAGES).
   GET  /:file  layani berkas <kode>.webp atau <kode>-thumb.webp; kalau hanya satu
                ukuran yang ada, ukuran satunya dilayani dari situ.
   POST /:code  ganti gambar sebuah barang (multipart: `full` dan `thumb`, keduanya WebP).
   DELETE /:code hapus gambar sebuah barang.
   POST dan DELETE butuh izin edit_catalog (manajer dan admin); sales hanya bisa melihat. */

import { Hono } from "hono";
import { batch, get, stmt } from "../../db.d1";
import { audit } from "../audit";
import { requireAuth, requirePermission } from "../auth";
import { itemImageCode, itemImageUrl, itemOtherFile, itemThumbFile } from "../../../shared/itemImages";
import type { Env } from "../env";

export const MAX_FULL_BYTES = 1_500_000;
export const MAX_THUMB_BYTES = 200_000;

export const itemImageRouter = new Hono<Env>();
itemImageRouter.use(requireAuth);

itemImageRouter.get("/:file", async (c) => {
  const file = c.req.param("file");
  if (!itemImageCode(file)) return c.json({ error: "Gambar tidak ditemukan." }, 404);
  const object = (await c.env.IMAGES?.get(file)) ?? (await c.env.IMAGES?.get(itemOtherFile(file)));
  if (!object) return c.json({ error: "Gambar tidak ditemukan." }, 404);
  // Nama berkas = kode barang, jadi gambar bisa diganti tanpa ganti nama. Browser wajib
  // bertanya ulang (ETag) supaya gambar pengganti langsung terlihat.
  const etag = object.httpEtag;
  const headers: Record<string, string> = { "Content-Type": "image/webp", "Cache-Control": "private, no-cache" };
  if (etag) headers.ETag = etag;
  if (etag && c.req.header("If-None-Match") === etag) {
    object.body?.cancel?.();
    return new Response(null, { status: 304, headers });
  }
  return new Response(object.body, { headers });
});

const isWebp = (b: Uint8Array) =>
  b.length >= 12 && String.fromCharCode(...b.subarray(0, 4)) === "RIFF" && String.fromCharCode(...b.subarray(8, 12)) === "WEBP";

/** Barang untuk kode dari URL, hanya bila kode sah sebagai nama berkas dan ada di katalog. */
async function catalogItemFor(db: D1Database, code: string) {
  if (itemImageCode(`${code}.webp`) !== code) return null;
  return get<{ id: number; code: string }>(db, "SELECT id, code FROM catalog_items WHERE code = ?", code);
}

itemImageRouter.post("/:code", requirePermission("edit_catalog"), async (c) => {
  const item = await catalogItemFor(c.env.DB, c.req.param("code") ?? "");
  if (!item) return c.json({ error: "Kode barang tidak ditemukan atau memakai karakter yang belum didukung untuk gambar." }, 404);
  if (!c.env.IMAGES) return c.json({ error: "Penyimpanan gambar belum aktif di server ini." }, 503);
  if (Number(c.req.header("content-length") ?? 0) > MAX_FULL_BYTES + MAX_THUMB_BYTES + 10_000)
    return c.json({ error: "Gambar terlalu besar." }, 413);

  const form = await c.req.formData().catch(() => null);
  const full = form?.get("full");
  const thumb = form?.get("thumb");
  if (!full || !thumb || typeof full === "string" || typeof thumb === "string")
    return c.json({ error: "Kirim dua berkas: gambar penuh dan thumbnail." }, 400);
  const fullBytes = new Uint8Array(await full.arrayBuffer());
  const thumbBytes = new Uint8Array(await thumb.arrayBuffer());
  if (!isWebp(fullBytes) || !isWebp(thumbBytes)) return c.json({ error: "Gambar harus berformat WebP." }, 400);
  if (fullBytes.length > MAX_FULL_BYTES || thumbBytes.length > MAX_THUMB_BYTES)
    return c.json({ error: "Gambar terlalu besar." }, 413);

  const opts = { httpMetadata: { contentType: "image/webp" } };
  await c.env.IMAGES.put(`${item.code}.webp`, fullBytes, opts);
  await c.env.IMAGES.put(itemThumbFile(item.code), thumbBytes, opts);
  await batch(c.env.DB, [stmt(c.env.DB, "INSERT OR IGNORE INTO item_images(code) VALUES (?)", item.code)]);
  await audit(c.env.DB, c.get("user")!.id, "catalog", item.id, "image_set", { code: item.code });
  return c.json({ image: itemImageUrl(item.code) });
});

itemImageRouter.delete("/:code", requirePermission("edit_catalog"), async (c) => {
  const item = await catalogItemFor(c.env.DB, c.req.param("code") ?? "");
  if (!item) return c.json({ error: "Kode barang tidak ditemukan." }, 404);
  if (!c.env.IMAGES) return c.json({ error: "Penyimpanan gambar belum aktif di server ini." }, 503);
  await c.env.IMAGES.delete([`${item.code}.webp`, itemThumbFile(item.code)]);
  await batch(c.env.DB, [stmt(c.env.DB, "DELETE FROM item_images WHERE code = ?", item.code)]);
  await audit(c.env.DB, c.get("user")!.id, "catalog", item.id, "image_removed", { code: item.code });
  return c.json({ ok: true });
});
