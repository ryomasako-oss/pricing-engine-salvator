import { useState } from "react";
import { hubFullImageUrl } from "@shared/hubImages";
import { ImageLightbox } from "./ImageLightbox";

/** Thumbnail barang dari Data Hub (lewat /api/hub-media), atau kotak kosong bila tidak ada gambar.
 *  Klik membuka gambar penuh di halaman yang sama, bisa di-zoom. */
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
      {open && <ImageLightbox src={hubFullImageUrl(src)} fallbackSrc={src} alt={alt} onClose={() => setOpen(false)} />}
    </>
  );
}
