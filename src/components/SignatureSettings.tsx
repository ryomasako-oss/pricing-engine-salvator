/* Settings → "Tanda tangan saya": the user's own signature (with the company
   stamp if they like) for the quotation letter. Printed only on an approved
   quote they created; a draft keeps the blank signing space. */
import { useEffect, useState } from "react";
import { api } from "../api";
import { useToast } from "../context/ToastContext";

const MAX_BYTES = 300_000;

export function SignatureSettings() {
  const toast = useToast();
  const [saved, setSaved] = useState<string | null>(null);
  const [image, setImage] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get<{ signature: string }>("/auth/signature").then((r) => { setSaved(r.signature); setImage((picked) => picked || r.signature); }).catch(() => setSaved(""));
  }, []);

  const pick = (file: File | undefined) => {
    if (!file) return;
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return toast("Format tanda tangan harus PNG, JPEG, atau WEBP.", "error");
    if (file.size > MAX_BYTES) return toast("Ukuran tanda tangan maksimum 300 KB.", "error");
    const reader = new FileReader();
    reader.onload = () => setImage(reader.result as string);
    reader.readAsDataURL(file);
  };

  const save = async () => {
    setSaving(true);
    try {
      await api.put("/auth/signature", { signature: image });
      setSaved(image);
      toast(image ? "Tanda tangan disimpan." : "Tanda tangan dihapus.", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Gagal menyimpan.", "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="card">
      <div className="card-head">
        <div className="card-title">
          <h2>Tanda tangan saya</h2>
          <span className="muted small">
            Tercetak di "Hormat kami" pada PDF penawaran yang Anda buat, setelah penawaran disetujui. Draft tetap tanpa tanda tangan.
          </span>
        </div>
      </div>
      <div className="card-body form-stack">
        <div className="row-wrap">
          {image ? (
            <img className="logo-preview" src={image} alt="Tanda tangan" />
          ) : (
            <span className="muted small">{saved === null ? "Memuat…" : "Belum ada tanda tangan."}</span>
          )}
          <input id="signature-upload" type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => pick(e.target.files?.[0])} />
          <label htmlFor="signature-upload" className="btn small">{image ? "Ganti gambar" : "Unggah gambar"}</label>
          {image && <button className="btn small ghost" onClick={() => setImage("")}>Hapus</button>}
        </div>
        <small className="field-help">Foto atau scan tanda tangan (boleh dengan cap perusahaan). PNG, JPEG, atau WEBP, maksimum 300 KB.</small>
        <div className="form-actions">
          <button className="btn primary" onClick={save} disabled={saving || saved === null || image === saved}>
            {saving ? "Menyimpan…" : "Simpan tanda tangan"}
          </button>
        </div>
      </div>
    </section>
  );
}
