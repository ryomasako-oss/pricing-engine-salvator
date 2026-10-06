/* Reads a client's PDF or photo into request rows through the server's OCR
   (server/ocr.ts). The browser does the base64 encoding and, for photos, the
   downscaling: a phone picture is often over the 4 MB the server accepts and
   far sharper than reading a price list needs. */

import { ApiError } from "../api";
import type { RequestLine } from "@shared/match";

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_SIDE = 2200;

const BY_EXTENSION: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
};

/** The type the OCR understands for this file, or null when it is a spreadsheet or something else. */
export function ocrMimeFor(file: File): string | null {
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  const known = new Set(Object.values(BY_EXTENSION));
  return known.has(file.type) ? file.type : (BY_EXTENSION[ext] ?? null);
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Shrinks a photo so it fits the upload limit; returns it unchanged when it already does or can't be decoded. */
async function shrinkImage(file: File, mime: string): Promise<{ bytes: Uint8Array; mime: string }> {
  const original = new Uint8Array(await file.arrayBuffer());
  if (mime === "image/heic" || mime === "image/heif") return { bytes: original, mime };
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && original.length <= MAX_BYTES) return { bytes: original, mime };
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, "image/jpeg", 0.85));
    return blob ? { bytes: new Uint8Array(await blob.arrayBuffer()), mime: "image/jpeg" } : { bytes: original, mime };
  } catch {
    return { bytes: original, mime };
  }
}

export async function ocrRequestList(file: File, mime: string): Promise<{ lines: RequestLine[]; notes: string[] }> {
  const { bytes, mime: sent } = mime === "application/pdf" ? { bytes: new Uint8Array(await file.arrayBuffer()), mime } : await shrinkImage(file, mime);
  if (bytes.length > MAX_BYTES) {
    throw new Error(`File ${(bytes.length / 1024 / 1024).toFixed(1)} MB; maksimal 4 MB. Kecilkan atau pecah filenya dulu.`);
  }
  let res: Response;
  try {
    res = await fetch("/api/ocr/extract", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "text/plain", "X-File-Mime": sent },
      body: toBase64(bytes),
    });
  } catch {
    throw new ApiError("Tidak bisa menghubungi server. Periksa koneksi Anda.", 0);
  }
  const data = (await res.json().catch(() => ({}))) as { lines?: RequestLine[]; truncated?: boolean; error?: string };
  if (!res.ok || !data.lines) {
    // No JSON body means the answer came from Cloudflare or a proxy (an error page), not from our server.
    const slow = res.status === 504 || res.status === 524 || res.status === 522 || res.status === 1102 || res.status >= 520;
    throw new ApiError(
      data.error || (slow ? "Pembacaan file terlalu lama. Coba file yang lebih kecil atau unggah Excel-nya." : `OCR gagal (${res.status}).`),
      res.status,
    );
  }
  return {
    lines: data.lines,
    notes: [
      `${data.lines.length} baris dibaca otomatis dari file. Cocokkan jumlahnya dengan file asli dan periksa nama serta qty tiap baris.`,
      ...(data.truncated ? ["File berisi lebih dari 500 baris; hanya 500 pertama yang dibaca."] : []),
    ],
  };
}
