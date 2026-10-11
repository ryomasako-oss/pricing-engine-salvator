/* ============================================================
   Gambar barang dari Data Hub Salvator.

   Hanya nama berkas gambar per kode barang yang disalin ke tabel
   hub_images. Browser tidak pernah bicara langsung ke Hub: ia
   memuat /api/hub-media/<berkas>, jadi kunci Hub tetap di server
   dan CSP tetap 'self'.

   Fitur hidup bila HUB_API_URL + HUB_API_KEY terisi; tanpa itu
   katalog tetap seperti biasa (tanpa gambar). Tidak ada sakelar
   di UI: gambar adalah tampilan, bukan pilihan bisnis.

   Stok dan HPP dari Hub adalah fitur terpisah (lihat
   feat/hub-stock-source) dan tidak bergantung pada berkas ini.

   Bagian ini murni (fetch + tipe); penulisan ke database ada di
   server/hubImages.ts (Node) dan server/worker/hubImages.ts (D1).
   ============================================================ */

export interface HubConfig {
  url: string;
  apiKey: string;
}

export interface HubImageRow {
  code: string;
  /** Nama berkas thumbnail (320 px) dan gambar penuh di /media/products Hub. */
  thumb: string;
  image: string;
}

export interface HubImagesStatus {
  lastSyncAt: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
  images: number;
}

export const HUB_IMAGES_STATUS_KEY = "hub_images_status";
export const EMPTY_HUB_IMAGES_STATUS: HubImagesStatus = { lastSyncAt: null, lastAttemptAt: null, lastError: null, images: 0 };

/** Salinan gambar diperbarui otomatis bila percobaan terakhir lebih lama dari ini. */
export const HUB_IMAGES_TTL_MS = 30 * 60 * 1000;

/** HUB_API_URL + HUB_API_KEY (secret server). Tanpa keduanya, gambar tidak dimuat. */
export function hubImagesConfigFrom(env: { HUB_API_URL?: string; HUB_API_KEY?: string }): HubConfig | null {
  const url = env.HUB_API_URL?.trim().replace(/\/+$/, "");
  const apiKey = env.HUB_API_KEY?.trim();
  return url && apiKey ? { url, apiKey } : null;
}

export function hubImagesAreStale(status: HubImagesStatus, now = Date.now()): boolean {
  return !status.lastAttemptAt || now - Date.parse(status.lastAttemptAt) > HUB_IMAGES_TTL_MS;
}

/** Nama berkas gambar Hub yang boleh diteruskan proxy: `<id>-<hash>.webp` atau `...-thumb.webp`. */
export const HUB_MEDIA_FILE = /^[0-9]+-[0-9a-f]{8,64}(-thumb)?\.webp$/;
export const HUB_MEDIA_ROUTE = "/api/hub-media";

/** URL gambar untuk browser (lewat proxy pricing engine) dari nama berkas di hub_images. */
export const hubMediaUrl = (file: string | null | undefined): string | null => (file ? `${HUB_MEDIA_ROUTE}/${file}` : null);

/** URL gambar penuh dari URL thumbnail (`<id>-<hash>-thumb.webp` -> `<id>-<hash>.webp`). */
export const hubFullImageUrl = (thumbUrl: string): string => thumbUrl.replace(/-thumb\.webp$/, ".webp");

async function hubGet(cfg: HubConfig, path: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${cfg.url}${path}`, {
      headers: { Authorization: `Bearer ${cfg.apiKey}`, Accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new Error(`Tidak bisa menghubungi Data Hub: ${err instanceof Error ? err.message : String(err)}`);
  }
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) throw new Error(`Data Hub menolak (HTTP ${res.status}): ${body?.error ?? "tanpa pesan"}`);
  return body;
}

/** Nama berkas dari URL gambar Hub; null bila bukan /media/products/<berkas yang sah>. */
function mediaFile(url: unknown, base: string): string | null {
  if (typeof url !== "string") return null;
  let pathname: string;
  try {
    pathname = new URL(url, base).pathname;
  } catch {
    return null;
  }
  const match = /^\/media\/products\/([^/]+)$/.exec(pathname);
  return match && HUB_MEDIA_FILE.test(match[1]!) ? match[1]! : null;
}

interface HubProductPage {
  data?: { sku: string; aliasCodes?: string[]; images?: { url?: string; thumbUrl?: string }[] }[];
  total?: number;
}

/** Gambar utama per kode barang dari GET /v1/products (semua halaman). Kode alias Hub
 *  mendapat gambar induknya, supaya katalog yang masih memakai kode lama tetap bergambar. */
export async function fetchHubImages(cfg: HubConfig): Promise<HubImageRow[]> {
  const pageSize = 500;
  const out: HubImageRow[] = [];
  let seen = 0;
  for (let page = 1; ; page++) {
    const body = (await hubGet(cfg, `/v1/products?page=${page}&pageSize=${pageSize}`)) as HubProductPage;
    const rows = body.data ?? [];
    seen += rows.length;
    for (const product of rows) {
      const first = product.images?.[0];
      const image = mediaFile(first?.url, cfg.url);
      const thumb = mediaFile(first?.thumbUrl, cfg.url);
      if (!image || !thumb) continue;
      for (const code of [product.sku, ...(product.aliasCodes ?? [])]) out.push({ code, thumb, image });
    }
    if (rows.length < pageSize || seen >= (body.total ?? 0)) return out;
  }
}