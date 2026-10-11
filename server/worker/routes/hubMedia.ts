/* /api/hub-media/:file — meneruskan satu berkas gambar Data Hub ke browser yang sudah login.
   Kunci Hub tidak pernah sampai ke browser; nama berkas sudah memuat hash isi gambar. */

import { Hono } from "hono";
import { requireAuth } from "../auth";
import { HUB_MEDIA_FILE, hubImagesConfigFrom } from "../../../shared/hubImages";
import type { Env } from "../env";

export const hubMediaRouter = new Hono<Env>();
hubMediaRouter.use(requireAuth);

hubMediaRouter.get("/:file", async (c) => {
  const cfg = hubImagesConfigFrom(c.env);
  const file = c.req.param("file");
  if (!cfg || !HUB_MEDIA_FILE.test(file)) return c.json({ error: "Gambar tidak ditemukan." }, 404);
  // /media/products Hub bersifat publik; kunci tidak dikirim ke sana.
  const upstream = await fetch(`${cfg.url}/media/products/${file}`, { signal: AbortSignal.timeout(20_000) }).catch(() => null);
  if (!upstream?.ok) {
    return c.json({ error: "Gambar tidak bisa diambil dari Data Hub." }, upstream?.status === 404 ? 404 : 502);
  }
  return new Response(upstream.body, {
    headers: { "Content-Type": "image/webp", "Cache-Control": "private, max-age=31536000, immutable" },
  });
});