/* /api/item-image — gambar barang di bucket R2 (binding IMAGES).
   GET  /:file  layani berkas <kode>.webp atau <kode>-thumb.webp; kalau hanya satu
                ukuran yang ada, ukuran satunya dilayani dari situ.
   POST /_check  untuk daftar kode: mana yang ada di katalog (kode resmi) dan sudah punya gambar.
   POST /:code  ganti gambar sebuah barang (multipart: `full` dan `thumb`, keduanya WebP).
   DELETE /:code hapus gambar sebuah barang.
   POST dan DELETE butuh izin edit_catalog (manajer dan admin); sales hanya bisa melihat. */

import { Hono, type Context } from "hono";
import { hasPermission } from "../../../shared/permissions";
import { z } from "zod";
import { all, batch, get, stmt } from "../../db.d1";
import { audit } from "../audit";
import { requireAuth, requirePermission } from "../auth";
import { itemImageCode, itemImageUrl, itemOtherFile, itemThumbFile } from "../../../shared/itemImages";
import type { Env } from "../env";

export const MAX_FULL_BYTES = 1_500_000;
export const MAX_THUMB_BYTES = 200_000;
/** Lama browser memakai gambar tanpa bertanya ulang. */
export const CACHE_SECONDS = 300;

export const itemImageRouter = new Hono<Env>();
itemImageRouter.use(requireAuth);

itemImageRouter.get("/:file", async (c) => {
  const file = c.req.param("file");
  if (!itemImageCode(file)) return c.json({ error: "Gambar tidak ditemukan." }, 404);
  const object = (await c.env.IMAGES?.get(file)) ?? (await c.env.IMAGES?.get(itemOtherFile(file)));
  if (!object) return c.json({ error: "Gambar tidak ditemukan." }, 404);
  // Nama berkas = kode barang, jadi gambar bisa diganti tanpa ganti nama. Browser memakai
  // salinannya CACHE_SECONDS detik tanpa bertanya (hemat panggilan Worker dan R2), lalu bertanya
  // ulang dengan ETag; gambar pengganti paling lambat terlihat setelah itu.
  const etag = object.httpEtag;
  const headers: Record<string, string> = { "Content-Type": "image/webp", "Cache-Control": `private, max-age=${CACHE_SECONDS}` };
  if (etag) headers.ETag = etag;
  if (etag && c.req.header("If-None-Match") === etag) {
    object.body?.cancel?.();
    return new Response(null, { status: 304, headers });
  }
  return new Response(object.body, { headers });
});

const isWebp = (b: Uint8Array) =>
  b.length >= 12 && String.fromCharCode(...b.subarray(0, 4)) === "RIFF" && String.fromCharCode(...b.subarray(8, 12)) === "WEBP";

/* Barang baru dari quotation (Ryoma, 2026-11-28): permintaan yang masih menunggu Accurate juga boleh diberi
   gambar, oleh peminta barangnya sendiri atau oleh yang boleh mengubah katalog. Gambar disimpan di bawah kode
   permintaan (BARU-0007 atau kode yang diketik); POST /pending-items/:id/link memindahkannya bila kodenya
   berubah. Barang katalog tetap hanya untuk edit_catalog. */
type ImageTarget = { entity: "catalog" | "pending_item"; id: number; code: string };

/** Barang yang gambarnya boleh diubah pengguna ini, atau jawaban error. */
async function imageTarget(c: Context<Env>, code: string): Promise<ImageTarget | Response> {
  const user = c.get("user")!;
  const editor = hasPermission(user.role, "edit_catalog");
  const item = await catalogItemFor(c.env.DB, code);
  if (item) return editor ? { entity: "catalog", ...item } : c.json({ error: "Akun ini tidak bisa mengubah gambar barang katalog." }, 403);
  if (itemImageCode(`${code}.webp`) !== code) return c.json({ error: "Kode barang tidak ditemukan, atau ada karakter yang tidak bisa dipakai untuk gambar." }, 404);
  const pending = await get<{ id: number; code: string; requested_by: number | null }>(
    c.env.DB,
    "SELECT id, code, requested_by FROM pending_items WHERE code = ? AND status IN ('draft', 'submitted')",
    code,
  );
  if (!pending) return c.json({ error: "Kode barang tidak ditemukan, atau ada karakter yang tidak bisa dipakai untuk gambar." }, 404);
  if (!editor && pending.requested_by !== user.id) return c.json({ error: "Hanya peminta barang baru ini atau manajer yang bisa mengubah gambarnya." }, 403);
  return { entity: "pending_item", id: pending.id, code: pending.code };
}

/** Barang untuk kode dari URL, hanya bila kode sah sebagai nama berkas dan ada di katalog. */
async function catalogItemFor(db: D1Database, code: string) {
  if (itemImageCode(`${code}.webp`) !== code) return null;
  // Katalog tidak membedakan huruf besar-kecil untuk kode (indeks NOCASE, migrasi 0025); kalau ada dua
  // kode yang hanya beda huruf, yang persis sama menang.
  return get<{ id: number; code: string }>(
    db,
    "SELECT id, code FROM catalog_items WHERE code = ? COLLATE NOCASE ORDER BY code = ? DESC LIMIT 1",
    code,
    code,
  );
}

// "_" bukan awal kode yang sah, jadi jalur ini tidak pernah bentrok dengan POST /:code.
itemImageRouter.post("/_check", requirePermission("edit_catalog"), async (c) => {
  const parsed = z.object({ codes: z.array(z.string().max(100)).max(500) }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Daftar kode tidak valid (maksimum 500)." }, 400);
  // Kolom code NOCASE: nama berkas "abc.webp" cocok dengan kode "ABC"; yang dikembalikan kode resminya.
  const rows = await all<{ input: string; code: string; has_image: number }>(
    c.env.DB,
    `SELECT j.value AS input, ci.code AS code, EXISTS(SELECT 1 FROM item_images ii WHERE ii.code = ci.code) AS has_image
       FROM json_each(?) j JOIN catalog_items ci ON ci.code = j.value COLLATE NOCASE`,
    JSON.stringify(parsed.data.codes),
  );
  // Satu kode masukan bisa cocok dengan dua kode yang beda huruf saja; yang persis sama menang.
  const best = new Map<string, (typeof rows)[number]>();
  for (const r of rows) if (!best.has(r.input) || r.code === r.input) best.set(r.input, r);
  return c.json({ items: [...best.values()].map((r) => ({ input: r.input, code: r.code, hasImage: !!r.has_image })) });
});

itemImageRouter.post("/:code", async (c) => {
  const item = await imageTarget(c, c.req.param("code") ?? "");
  if (item instanceof Response) return item;
  if (!c.env.IMAGES) return c.json({ error: "Penyimpanan gambar belum aktif di server ini." }, 503);
  if (Number(c.req.header("content-length") ?? 0) > MAX_FULL_BYTES + MAX_THUMB_BYTES + 10_000)
    return c.json({ error: "Gambar terlalu besar." }, 413);

  const form = await c.req.formData().catch(() => null);
  const full = form?.get("full");
  const thumb = form?.get("thumb");
  if (!full || !thumb || typeof full === "string" || typeof thumb === "string")
    return c.json({ error: "Kirim dua file: gambar penuh dan thumbnail." }, 400);
  const fullBytes = new Uint8Array(await full.arrayBuffer());
  const thumbBytes = new Uint8Array(await thumb.arrayBuffer());
  if (!isWebp(fullBytes) || !isWebp(thumbBytes)) return c.json({ error: "Gambar harus berformat WebP." }, 400);
  if (fullBytes.length > MAX_FULL_BYTES || thumbBytes.length > MAX_THUMB_BYTES)
    return c.json({ error: "Gambar terlalu besar." }, 413);

  const opts = { httpMetadata: { contentType: "image/webp" } };
  await c.env.IMAGES.put(`${item.code}.webp`, fullBytes, opts);
  await c.env.IMAGES.put(itemThumbFile(item.code), thumbBytes, opts);
  await batch(c.env.DB, [stmt(c.env.DB, "INSERT OR IGNORE INTO item_images(code) VALUES (?)", item.code)]);
  await audit(c.env.DB, c.get("user")!.id, item.entity, item.id, "image_set", { code: item.code });
  return c.json({ image: itemImageUrl(item.code) });
});

itemImageRouter.delete("/:code", async (c) => {
  const item = await imageTarget(c, c.req.param("code") ?? "");
  if (item instanceof Response) return item;
  if (!c.env.IMAGES) return c.json({ error: "Penyimpanan gambar belum aktif di server ini." }, 503);
  await c.env.IMAGES.delete([`${item.code}.webp`, itemThumbFile(item.code)]);
  await batch(c.env.DB, [stmt(c.env.DB, "DELETE FROM item_images WHERE code = ?", item.code)]);
  await audit(c.env.DB, c.get("user")!.id, item.entity, item.id, "image_removed", { code: item.code });
  return c.json({ ok: true });
});
