/* Gambar barang dari Data Hub — sisi Node/SQLite. Logika fetch ada di shared/hubImages.ts;
   berkas ini hanya menyimpan status dan salinan nama berkas (tabel hub_images). */

import { getSetting, run, setSetting, tx } from "./db.js";
import {
  EMPTY_HUB_IMAGES_STATUS,
  HUB_IMAGES_STATUS_KEY,
  fetchHubImages,
  hubImagesAreStale,
  hubImagesConfigFrom,
  type HubConfig,
  type HubImagesStatus,
} from "../shared/hubImages.js";

export const hubImagesConfig = (): HubConfig | null => hubImagesConfigFrom(process.env);

export const getHubImagesStatus = (): HubImagesStatus => getSetting(HUB_IMAGES_STATUS_KEY, EMPTY_HUB_IMAGES_STATUS);

/** true bila gambar harus dimuat (Hub terkonfigurasi). Tanpa sakelar: gambar adalah tampilan. */
export function useHubImages(): boolean {
  return hubImagesConfig() !== null;
}

/** Menarik ulang nama berkas gambar dari Hub ke hub_images. Gagal = salinan lama tetap dipakai. */
export async function refreshHubImages(): Promise<HubImagesStatus> {
  const cfg = hubImagesConfig();
  const previous = getHubImagesStatus();
  const attemptAt = new Date().toISOString();
  setSetting(HUB_IMAGES_STATUS_KEY, { ...previous, lastAttemptAt: attemptAt });
  let status: HubImagesStatus;
  try {
    if (!cfg) throw new Error("HUB_API_URL dan HUB_API_KEY belum diisi di server.");
    const rows = await fetchHubImages(cfg);
    tx(() => {
      run("DELETE FROM hub_images");
      for (const row of rows) run("INSERT OR REPLACE INTO hub_images(code, thumb, image) VALUES(?, ?, ?)", row.code, row.thumb, row.image);
    });
    status = { lastSyncAt: attemptAt, lastAttemptAt: attemptAt, lastError: null, images: rows.length };
  } catch (err) {
    status = { ...previous, lastAttemptAt: attemptAt, lastError: err instanceof Error ? err.message : String(err) };
  }
  setSetting(HUB_IMAGES_STATUS_KEY, status);
  return status;
}

/** Dipanggil saat katalog dibuka: perbarui bila salinan sudah basi. Tidak pernah melempar. */
export async function refreshHubImagesIfStale(): Promise<void> {
  if (hubImagesConfig() === null) return;
  if (!hubImagesAreStale(getHubImagesStatus())) return;
  await refreshHubImages().catch((err) => console.error("[hub-images] refresh gagal:", err));
}