/* GET /api/item-image/:file — padanan Workers dari server/routes/itemImage.ts.
   Berkasnya diambil dari bucket R2 (binding IMAGES). Kalau hanya gambar penuh
   yang ada, berkas -thumb dilayani dari gambar penuh. */

import { Hono } from "hono";
import { requireAuth } from "../auth";
import { itemFullFile, itemImageCode } from "../../../shared/itemImages";
import type { Env } from "../env";

export const itemImageRouter = new Hono<Env>();
itemImageRouter.use(requireAuth);

itemImageRouter.get("/:file", async (c) => {
  const file = c.req.param("file");
  if (!itemImageCode(file)) return c.json({ error: "Gambar tidak ditemukan." }, 404);
  const object = (await c.env.IMAGES?.get(file)) ?? (await c.env.IMAGES?.get(itemFullFile(file)));
  if (!object) return c.json({ error: "Gambar tidak ditemukan." }, 404);
  // Nama berkas ikut berubah kalau isinya berubah, jadi aman disimpan lama.
  return new Response(object.body, {
    headers: { "Content-Type": "image/webp", "Cache-Control": "private, max-age=31536000, immutable" },
  });
});