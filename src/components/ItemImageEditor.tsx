import { useRef, useState } from "react";
import { api } from "../api";
import { useToast } from "../context/ToastContext";
import { Icon } from "./Icon";
import { Thumb } from "./Thumb";

const FULL_SIDE = 1200;
const THUMB_SIDE = 128;

/** Perkecil gambar apa pun yang bisa dibuka browser (JPG, PNG, WebP, ...) menjadi WebP
 *  dengan sisi terpanjang `side`. Gagal bila browser tidak bisa menulis WebP. */
async function toWebp(file: File, side: number, quality: number): Promise<Blob> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const scale = Math.min(1, side / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, "image/webp", quality));
  if (!blob || blob.type !== "image/webp") throw new Error("Browser ini tidak bisa membuat gambar WebP.");
  return blob;
}

/** Ganti atau hapus gambar satu barang. Berlaku langsung (tidak menunggu tombol Simpan),
 *  karena gambar disimpan terpisah dari data barang. Hanya dipasang untuk peran yang
 *  boleh mengubah katalog; server memeriksa izin yang sama. */
export function ItemImageEditor({ code, image, onChanged }: { code: string; image: string | null; onChanged: () => void }) {
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  // Pratinjau lokal supaya gambar baru langsung terlihat, tanpa menunggu cache browser.
  const [local, setLocal] = useState<string | null | undefined>(undefined);
  const shown = local === undefined ? image : local;

  async function pick(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    try {
      const [full, thumb] = await Promise.all([toWebp(file, FULL_SIDE, 0.85), toWebp(file, THUMB_SIDE, 0.8)]);
      const form = new FormData();
      form.set("full", full, `${code}.webp`);
      form.set("thumb", thumb, `${code}-thumb.webp`);
      await api.upload(`/item-image/${encodeURIComponent(code)}`, form);
      setLocal((old) => {
        if (old) URL.revokeObjectURL(old);
        return URL.createObjectURL(thumb);
      });
      toast("Gambar disimpan.", "success");
      onChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Gagal mengunggah gambar.", "error");
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await api.del(`/item-image/${encodeURIComponent(code)}`);
      setLocal(null);
      toast("Gambar dihapus.", "success");
      onChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Gagal menghapus gambar.", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="field">
      <span>Gambar barang</span>
      <div className="row-wrap" style={{ gap: 10, alignItems: "center" }}>
        <Thumb src={shown} alt={code} />
        <input ref={input} type="file" accept="image/*" hidden onChange={(e) => pick(e.target.files?.[0])} />
        <button type="button" className="btn small" disabled={busy} onClick={() => input.current?.click()}>
          <Icon name="plus" size={13} /> {busy ? "Memproses…" : shown ? "Ganti gambar" : "Unggah gambar"}
        </button>
        {shown && (
          <button type="button" className="btn small ghost" disabled={busy} onClick={remove}>
            Hapus
          </button>
        )}
        <span className="muted small">JPG, PNG, atau WebP. Diperkecil otomatis.</span>
      </div>
    </div>
  );
}
