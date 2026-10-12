/* Gambar barang — sisi Node/SQLite. Daftar kode diambil dari folder gambar
   (IMAGES_DIR); nama berkasnya sudah mengikuti kode barang, jadi sinkronnya
   hanya satu bacaan direktori. Lihat shared/itemImages.ts. */

import fs from "node:fs";
import path from "node:path";
import { getSetting, run, setSetting, tx } from "./db.js";
import {
  EMPTY_ITEM_IMAGES_STATUS,
  ITEM_IMAGES_STATUS_KEY,
  itemImageCode,
  itemImagesAreStale,
  type ItemImagesStatus,
} from "../shared/itemImages.js";

/** Folder gambar. Override dengan IMAGES_DIR kalau gambarnya disimpan di luar repo. */
export const imagesDir = (): string => path.resolve(process.env.IMAGES_DIR || "./data/images");

export const getItemImagesStatus = (): ItemImagesStatus => getSetting(ITEM_IMAGES_STATUS_KEY, EMPTY_ITEM_IMAGES_STATUS);

/** Kode yang punya gambar di folder. Folder tidak ada = belum ada gambar, bukan error. */
export function scanImageCodes(dir = imagesDir()): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  // Satu kode bisa punya `-thumb` dan penuh; cukup dihitung sekali.
  return [...new Set(names.map(itemImageCode).filter((code): code is string => code !== null))];
}

/** Jalur berkas gambar. Kode sudah divalidasi sebelum sampai sini. */
export const imageFilePath = (file: string, dir = imagesDir()): string => path.join(dir, path.basename(file));

export async function refreshItemImages(): Promise<ItemImagesStatus> {
  const previous = getItemImagesStatus();
  const attemptAt = new Date().toISOString();
  setSetting(ITEM_IMAGES_STATUS_KEY, { ...previous, lastAttemptAt: attemptAt });
  let status: ItemImagesStatus;
  try {
    const codes = scanImageCodes();
    tx(() => {
      run("DELETE FROM item_images");
      for (const code of codes) run("INSERT OR IGNORE INTO item_images(code) VALUES(?)", code);
    });
    status = { lastSyncAt: attemptAt, lastAttemptAt: attemptAt, lastError: null, images: codes.length };
  } catch (err) {
    status = { ...previous, lastAttemptAt: attemptAt, lastError: err instanceof Error ? err.message : String(err) };
  }
  setSetting(ITEM_IMAGES_STATUS_KEY, status);
  return status;
}

/** Dipanggil saat katalog atau quotation dibuka: perbarui bila daftarnya sudah basi. */
export async function refreshItemImagesIfStale(): Promise<void> {
  if (!itemImagesAreStale(getItemImagesStatus())) return;
  await refreshItemImages().catch((err) => console.error("[item-images] refresh gagal:", err));
}