/* /api/hub-media/:file — padanan Nodes dari server/worker/routes/hubMedia.ts. */

import { Router } from "express";
import { requireAuth } from "../auth.js";
import { HUB_MEDIA_FILE } from "../../shared/hubImages.js";
import { hubImagesConfig } from "../hubImages.js";

export const hubMediaRouter = Router();
hubMediaRouter.use(requireAuth);

hubMediaRouter.get("/:file", async (req, res) => {
  const cfg = hubImagesConfig();
  const file = req.params.file;
  if (!cfg || !HUB_MEDIA_FILE.test(file)) {
    res.status(404).json({ error: "Gambar tidak ditemukan." });
    return;
  }
  // /media/products Hub bersifat publik; kunci tidak dikirim ke sana.
  const upstream = await fetch(`${cfg.url}/media/products/${file}`, { signal: AbortSignal.timeout(20_000) }).catch(() => null);
  if (!upstream?.ok) {
    res.status(upstream?.status === 404 ? 404 : 502).json({ error: "Gambar tidak bisa diambil dari Data Hub." });
    return;
  }
  // Nama berkas memuat hash isi gambar, jadi isinya tidak pernah berubah.
  res.setHeader("Content-Type", "image/webp");
  res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
  res.send(Buffer.from(await upstream.arrayBuffer()));
});