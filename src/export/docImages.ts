/* Item photos for the quotation PDF (Ryoma, 2026-11-26): the catalog thumbnails (/api/item-image, WebP),
   turned into JPEG data URLs jsPDF can embed. Only codes that have a photo are fetched; the rest are blank cells. */

import { itemImageCode, itemImageUrl } from "@shared/itemImages";
import { api } from "../api";

/** The codes that have a photo (the image map of POST /api/catalog/units), so none is fetched for a code without. */
export async function photoCodes(codes: string[]): Promise<Set<string>> {
  const ask = [...new Set(codes)].filter((c) => itemImageCode(`${c}.webp`));
  if (!ask.length) return new Set();
  const r = await api.post<{ images?: Record<string, string> }>("/catalog/units", { codes: ask });
  return new Set(Object.keys(r.images ?? {}));
}

/** WebP blob -> JPEG data URL on white (a transparent PNG/WebP would turn black in a JPEG). */
async function toJpeg(blob: Blob): Promise<string> {
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return canvas.toDataURL("image/jpeg", 0.85);
}

/** Code -> photo, for the codes that have one. Six requests at a time. */
export async function loadDocImages(codes: string[]): Promise<Record<string, string>> {
  const todo = [...(await photoCodes(codes).catch(() => new Set<string>()))];
  const out: Record<string, string> = {};
  // shortcut: one request per photo (thumbs are cached 5 min); fine for quotes of tens of lines, batch if quotes reach hundreds.
  const worker = async () => {
    for (let code = todo.shift(); code !== undefined; code = todo.shift()) {
      try {
        const r = await fetch(itemImageUrl(code), { credentials: "same-origin" });
        if (r.ok) out[code] = await toJpeg(await r.blob());
      } catch {
        // A photo that fails to load is a blank cell, not a failed PDF.
      }
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return out;
}
