/* ============================================================
   Gambar barang, disimpan sendiri oleh pricing engine.

   Byte gambar tidak diambil dari server lain. Filenya diletakkan
   di storage sendiri dan dinamai mengikuti kode barang:

     <kode>.webp         gambar penuh
     <kode>-thumb.webp   thumbnail

   Storage cukup folder di Node (IMAGES_DIR) dan bucket R2 di
   Workers (binding IMAGES). Dua-duanya memakai nama yang sama,
   jadi cara mengimpornya tidak berbeda antar backend.

   Tabel item_images hanya mencatat kode mana yang punya gambar.
   Tanpa itu, katalog harus mencoba memuat satu gambar per barang
   dan barang tanpa gambar akan menambah 404 di setiap halaman.

   Kalau hanya gambar penuh yang ada (tanpa -thumb), route
   melayaninya untuk dua nama berkas itu.
   ============================================================ */

export interface ItemImagesStatus {
  lastSyncAt: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
  images: number;
}

export const ITEM_IMAGES_STATUS_KEY = "item_images_status";
export const EMPTY_ITEM_IMAGES_STATUS: ItemImagesStatus = {
  lastSyncAt: null,
  lastAttemptAt: null,
  lastError: null,
  images: 0,
};

/** Daftar kode disegarkan otomatis bila percobaan terakhir lebih lama dari ini. */
export const ITEM_IMAGES_TTL_MS = 30 * 60 * 1000;

export function itemImagesAreStale(status: ItemImagesStatus, now = Date.now()): boolean {
  return !status.lastAttemptAt || now - Date.parse(status.lastAttemptAt) > ITEM_IMAGES_TTL_MS;
}

/** Nama berkas gambar yang boleh dilayani: `<kode>.webp`. Kode tidak boleh memuat
 *  slash, titik bertumpuk, atau karakter lain yang bisa keluar dari foldernya. */
export const ITEM_IMAGE_FILE = /^([A-Za-z0-9][A-Za-z0-9._-]{0,63})\.webp$/;

/**
 * Kode barang dari nama berkas gambar; null bila bukan gambar yang sah.
 * Sengaja ketat tanpa ada prefix: nama berkas harus persis `<kode>.webp` atau
 * `<kode>-thumb.webp`, jadi `../rahasia.webp`, `sub/ATK-1.webp`, dan `a..b.webp`
 * semuanya ditolak. Kita yang menulis berkasnya, jadi tidak perlu prefix yang longgar.
 * `X-thumb.webp` dan `X.webp` sama-sama menghasilkan kode `X`.
 */
export function itemImageCode(name: string): string | null {
  const code = ITEM_IMAGE_FILE.exec(name)?.[1];
  return code && !code.includes("..") ? code.replace(/-thumb$/, "") : null;
}

export const ITEM_IMAGE_ROUTE = "/api/item-image";

/** Nama berkas thumbnail untuk sebuah kode barang. */
export const itemThumbFile = (code: string): string => `${code}-thumb.webp`;

/** URL thumbnail untuk browser. Proxy ini butuh login, jadi tidak ada URL publik. */
export const itemImageUrl = (code: string): string => `${ITEM_IMAGE_ROUTE}/${itemThumbFile(code)}`;

/** Nama berkas dari URL thumbnail (`<kode>-thumb.webp` -> `<kode>.webp`). */
export const itemFullFile = (file: string): string => file.replace(/-thumb\.webp$/, ".webp");

/** URL gambar penuh dari URL thumbnail, untuk lightbox. */
export const itemFullImageUrl = (thumbUrl: string): string => thumbUrl.replace(/-thumb\.webp$/, ".webp");