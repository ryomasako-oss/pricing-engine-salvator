/* GET /api/item-image/:file — melayani satu berkas gambar dari storage sendiri
   (IMAGES_DIR). Butuh login, jadi nama berkasnya tidak pernah jadi URL publik.
   Kalau hanya gambar penuh yang ada, berkas -thumb dilayani dari gambar penuh. */

import fs from "node:fs";
import { Router } from "express";
import { requireAuth } from "../auth.js";
import { itemImageCode, itemOtherFile } from "../../shared/itemImages.js";
import { imageFilePath } from "../itemImages.js";

export const itemImageRouter = Router();
itemImageRouter.use(requireAuth);

/** Kirim berkas kalau ada; kalau tidak, coba pasangannya (thumb <-> penuh). */
function sendFirstAvailable(res: import("express").Response, file: string): void {
  const send = (candidate: string): boolean => {
    const full = imageFilePath(candidate);
    if (!fs.existsSync(full)) return false;
    res.setHeader("Content-Type", "image/webp");
    // Nama berkas ikut berubah kalau isinya berubah, jadi aman disimpan lama.
    res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
    fs.createReadStream(full).pipe(res);
    return true;
  };
  if (!send(file) && !send(itemOtherFile(file))) res.status(404).json({ error: "Gambar tidak ditemukan." });
}

itemImageRouter.get("/:file", (req, res) => {
  if (!itemImageCode(req.params.file)) {
    res.status(404).json({ error: "Gambar tidak ditemukan." });
    return;
  }
  sendFirstAvailable(res, req.params.file);
});