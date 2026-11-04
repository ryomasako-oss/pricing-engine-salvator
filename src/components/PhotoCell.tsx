/* A catalog item's product photo: thumbnail when present, upload control when
   not. The file is compressed by fileToProductImage before onChange gets it. */

import { useId, useState } from "react";
import { useToast } from "../context/ToastContext";
import { fileToProductImage } from "../import/productImage";
import { Icon } from "./Icon";

interface Props {
  image?: string;
  name: string;
  readOnly?: boolean;
  /** Saves the new photo (a data URL), or removes it on undefined. */
  onChange: (image: string | undefined) => Promise<void>;
}

export function PhotoCell({ image, name, readOnly, onChange }: Props) {
  const toast = useToast();
  const inputId = useId();
  const [busy, setBusy] = useState(false);

  if (readOnly) {
    return image ? (
      <img className="quote-thumb" src={image} alt={`Foto ${name}`} />
    ) : (
      <span className="muted small">—</span>
    );
  }

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      await onChange(await fileToProductImage(file));
    } catch (err) {
      toast(err instanceof Error ? err.message : "Gagal membaca foto.", "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="quote-photo-cell">
      <input
        id={inputId}
        className="photo-input"
        type="file"
        accept="image/png,image/jpeg,image/webp,image/heic,image/heif"
        disabled={busy}
        onChange={(e) => {
          const file = e.target.files?.[0];
          // Reset so choosing the same file again still fires onChange.
          e.target.value = "";
          void pick(file);
        }}
      />
      {image ? (
        <>
          <label htmlFor={inputId} className="quote-photo" title="Klik untuk ganti foto">
            <img src={image} alt={`Foto ${name}`} />
            {busy && <span className="photo-busy" aria-hidden="true" />}
          </label>
          <button
            type="button"
            className="photo-remove"
            aria-label={`Hapus foto ${name}`}
            title="Hapus foto"
            onClick={() => void onChange(undefined).catch((err) => toast(err instanceof Error ? err.message : "Gagal menghapus foto.", "error"))}
          >
            <Icon name="x" size={10} />
          </button>
        </>
      ) : (
        <label htmlFor={inputId} className="photo-add" title="Unggah foto produk">
          <Icon name={busy ? "clock" : "image"} size={16} />
          <span>{busy ? "…" : "Foto"}</span>
        </label>
      )}
    </div>
  );
}
