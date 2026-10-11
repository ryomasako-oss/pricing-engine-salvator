/* Gambar barang dari Data Hub — sisi Workers/D1. Logika fetch ada di shared/hubImages.ts;
   berkas ini hanya menyimpan status dan salinan nama berkas (tabel hub_images). */

import { batch, getSetting, setSetting, stmt } from "../db.d1";
import {
  EMPTY_HUB_IMAGES_STATUS,
  HUB_IMAGES_STATUS_KEY,
  fetchHubImages,
  hubImagesAreStale,
  hubImagesConfigFrom,
  type HubImagesStatus,
} from "../../shared/hubImages";
import type { Bindings } from "./env";

export const getHubImagesStatus = (d1: D1Database): Promise<HubImagesStatus> =>
  getSetting(d1, HUB_IMAGES_STATUS_KEY, EMPTY_HUB_IMAGES_STATUS);

/** true bila gambar harus dimuat (Hub terkonfigurasi). Tanpa sakelar: gambar adalah tampilan. */
export async function hubImagesEnabled(env: Bindings): Promise<boolean> {
  return hubImagesConfigFrom(env) !== null;
}

// D1 membatasi 100 parameter per statement: 3 parameter per baris -> 33 baris per INSERT.
const IMAGE_ROWS_PER_INSERT = 33;

/** Menarik ulang nama berkas gambar dari Hub ke hub_images. Gagal = salinan lama tetap dipakai. */
export async function refreshHubImages(env: Bindings): Promise<HubImagesStatus> {
  const cfg = hubImagesConfigFrom(env);
  const previous = await getHubImagesStatus(env.DB);
  const attemptAt = new Date().toISOString();
  await setSetting(env.DB, HUB_IMAGES_STATUS_KEY, { ...previous, lastAttemptAt: attemptAt });
  let status: HubImagesStatus;
  try {
    if (!cfg) throw new Error("HUB_API_URL dan HUB_API_KEY belum diisi di server.");
    const rows = await fetchHubImages(cfg);
    const statements = [stmt(env.DB, "DELETE FROM hub_images")];
    for (let i = 0; i < rows.length; i += IMAGE_ROWS_PER_INSERT) {
      const chunk = rows.slice(i, i + IMAGE_ROWS_PER_INSERT);
      statements.push(
        stmt(
          env.DB,
          `INSERT OR REPLACE INTO hub_images(code, thumb, image) VALUES ${chunk.map(() => "(?, ?, ?)").join(", ")}`,
          ...chunk.flatMap((row) => [row.code, row.thumb, row.image]),
        ),
      );
    }
    await batch(env.DB, statements);
    status = { lastSyncAt: attemptAt, lastAttemptAt: attemptAt, lastError: null, images: rows.length };
  } catch (err) {
    status = { ...previous, lastAttemptAt: attemptAt, lastError: err instanceof Error ? err.message : String(err) };
  }
  await setSetting(env.DB, HUB_IMAGES_STATUS_KEY, status);
  return status;
}

/** Dipanggil saat katalog dibuka: perbarui bila salinan sudah basi. Tidak pernah melempar. */
export async function refreshHubImagesIfStale(env: Bindings): Promise<void> {
  if (hubImagesConfigFrom(env) === null) return;
  if (!hubImagesAreStale(await getHubImagesStatus(env.DB))) return;
  await refreshHubImages(env).catch((err) => console.error("[hub-images] refresh gagal:", err));
}