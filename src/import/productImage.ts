/* Product photos are stored inside the quotation (a data URL on each line),
   so they must stay small. This resizes and re-encodes a picked file in the
   browser before it ever reaches the quote — the server only validates the
   result. */

import { MAX_ITEM_IMAGE_CHARS } from "@shared/images";

const ACCEPTED = /^image\/(png|jpe?g|webp|heic|heif)$/i;
const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
const MAX_EDGE = 360;
const MAX_DATA_URL_LENGTH = MAX_ITEM_IMAGE_CHARS;

export async function fileToProductImage(file: File): Promise<string> {
  if (!ACCEPTED.test(file.type)) {
    throw new Error("Format foto harus JPG, PNG, atau WEBP.");
  }
  if (file.size > MAX_SOURCE_BYTES) {
    throw new Error("Ukuran foto maksimum 20 MB.");
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new Error("Foto tidak bisa dibaca browser ini. Coba simpan sebagai JPG lalu unggah lagi.");
  }

  try {
    let scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    for (let attempt = 0; attempt < 4; attempt++) {
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      // Square, the photo centred on white: every thumbnail slot (table, PDF,
      // Excel's fixed 30x30 picture) then shows the whole product, unstretched.
      const side = Math.max(width, height);
      const canvas = document.createElement("canvas");
      canvas.width = side;
      canvas.height = side;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Browser tidak bisa mengolah foto ini.");
      // White, not transparent: product photos are JPEGs in the PDF.
      ctx.fillStyle = "#FFFFFF";
      ctx.fillRect(0, 0, side, side);
      ctx.drawImage(bitmap, (side - width) / 2, (side - height) / 2, width, height);

      for (const quality of [0.8, 0.68, 0.56]) {
        const dataUrl = canvas.toDataURL("image/jpeg", quality);
        if (dataUrl.length <= MAX_DATA_URL_LENGTH) return dataUrl;
      }
      scale *= 0.72;
    }
  } finally {
    bitmap.close();
  }

  throw new Error("Foto masih terlalu besar setelah dikompres. Pilih foto lain.");
}
