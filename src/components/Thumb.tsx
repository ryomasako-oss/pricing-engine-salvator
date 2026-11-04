import { useState } from "react";
import { itemFullImageUrl } from "@shared/itemImages";
import { ImageLightbox } from "./ImageLightbox";

/** Thumbnail barang (lewat /api/item-image), atau kotak kosong bila kode ini tidak punya
 *  gambar. Klik membuka gambar penuh di halaman yang sama, bisa di-zoom. */
export function Thumb({ src, alt }: { src?: string | null; alt: string }) {
  const [open, setOpen] = useState(false);
  if (!src) return <span className="thumb thumb-empty" aria-hidden="true" />;
  return (
    <>
      <img
        className="thumb thumb-zoomable"
        src={src}
        alt={alt}
        title="Klik untuk memperbesar"
        loading="lazy"
        decoding="async"
        onClick={() => setOpen(true)}
      />
      {open && <ImageLightbox src={itemFullImageUrl(src)} fallbackSrc={src} alt={alt} onClose={() => setOpen(false)} />}
    </>
  );
}
