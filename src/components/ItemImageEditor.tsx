import { useRef, useState } from "react";
import { api } from "../api";
import { useToast } from "../context/ToastContext";
import { Icon } from "./Icon";
import { Thumb } from "./Thumb";
import { uploadItemImage } from "../lib/itemImageUpload";

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
      const thumb = await uploadItemImage(code, file);
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
