/* Product photos: one per catalog item, stored as a small data URL in
   catalog_images and shown on quotations by line code. */

/** One compressed photo, as a data URL. ~24 KB of image data. */
export const MAX_ITEM_IMAGE_CHARS = 32_000;

/** Raster formats every browser, jsPDF and Excel can draw; SVG excluded on purpose. */
export const IMAGE_DATA_URL = /^data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

/** Where the browser loads a catalog photo; `v` changes on upload, so the URL can be cached forever. */
export const catalogImageUrl = (code: string, v: number) =>
  `/api/catalog/image?code=${encodeURIComponent(code)}&v=${v}`;
