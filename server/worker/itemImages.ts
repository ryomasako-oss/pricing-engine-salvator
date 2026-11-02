/* Gambar barang — sisi Workers/R2. Daftar kode diambil dari bucket R2 (binding
   IMAGES); nama objeknya sudah mengikuti kode barang, jadi sinkronnya hanya satu
   listing. Lihat shared/itemImages.ts. */

import { batch, getSetting, setSetting, stmt } from "../db.d1";
import {
  EMPTY_ITEM_IMAGES_STATUS,
  ITEM_IMAGES_STATUS_KEY,
  itemImageCode,
  itemImagesAreStale,
  type ItemImagesStatus,
} from "../../shared/itemImages";
import type { Bindings } from "./env";

export const getItemImagesStatus = (d1: D1Database): Promise<ItemImagesStatus> =>
  getSetting(d1, ITEM_IMAGES_STATUS_KEY, EMPTY_ITEM_IMAGES_STATUS);

/** Semua kunci di bucket, menyusuri halaman. Bucket kosong = belum ada gambar. */
async function listKeys(bucket: R2Bucket): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list(cursor ? { cursor } : {});
    for (const object of page.objects) keys.push(object.key);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys;
}

/** Kode yang punya gambar di bucket. Binding yang belum ada dianggap "belum ada gambar". */
export async function scanImageCodes(bucket: R2Bucket | undefined): Promise<string[]> {
  if (!bucket) return [];
  // Satu kode bisa punya `-thumb` dan penuh; cukup dihitung sekali.
  const keys = await listKeys(bucket);
  return [...new Set(keys.map(itemImageCode).filter((code): code is string => code !== null))];
}

// D1 membatasi 100 parameter per statement -> 100 kode per INSERT.
const CODES_PER_INSERT = 100;

export async function refreshItemImages(env: Bindings): Promise<ItemImagesStatus> {
  const previous = await getItemImagesStatus(env.DB);
  const attemptAt = new Date().toISOString();
  await setSetting(env.DB, ITEM_IMAGES_STATUS_KEY, { ...previous, lastAttemptAt: attemptAt });
  let status: ItemImagesStatus;
  try {
    const codes = await scanImageCodes(env.IMAGES);
    const statements = [stmt(env.DB, "DELETE FROM item_images")];
    for (let i = 0; i < codes.length; i += CODES_PER_INSERT) {
      const chunk = codes.slice(i, i + CODES_PER_INSERT);
      statements.push(
        stmt(
          env.DB,
          `INSERT OR IGNORE INTO item_images(code) VALUES ${chunk.map(() => "(?)").join(", ")}`,
          ...chunk,
        ),
      );
    }
    await batch(env.DB, statements);
    status = { lastSyncAt: attemptAt, lastAttemptAt: attemptAt, lastError: null, images: codes.length };
  } catch (err) {
    status = { ...previous, lastAttemptAt: attemptAt, lastError: err instanceof Error ? err.message : String(err) };
  }
  await setSetting(env.DB, ITEM_IMAGES_STATUS_KEY, status);
  return status;
}

/** Dipanggil saat katalog atau quotation dibuka: perbarui bila daftarnya sudah basi. */
export async function refreshItemImagesIfStale(env: Bindings): Promise<void> {
  if (!itemImagesAreStale(await getItemImagesStatus(env.DB))) return;
  await refreshItemImages(env).catch((err) => console.error("[item-images] refresh gagal:", err));
}