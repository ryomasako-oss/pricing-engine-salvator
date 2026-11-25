import { useEffect, useState } from "react";
import { Modal } from "./Modal";
import { api } from "../api";
import type { CatalogItem } from "@shared/types";

/* Modal "Laporkan duplikat" di baris Katalog.
 * Vee memilih barang pasangannya (cari lewat kode/nama), menulis catatan
 * singkat, lalu mengirim. Laporan masuk ke antrean Duplikat — BUKAN ke
 * antrean draf Gudang yang lama, dan tidak mengubah katalog sama sekali.
 */

export default function ReportDuplicateModal({
  item,
  onClose,
}: {
  item: CatalogItem;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CatalogItem[]>([]);
  const [selected, setSelected] = useState<CatalogItem | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (query.trim().length < 2) {
      setResults([]);
      return;
    }
    const t = setTimeout(async () => {
      try {
        const res = await api.get<{ items: CatalogItem[] }>(`/catalog?q=${encodeURIComponent(query)}&limit=20`);
        setResults(res.items.filter((r) => r.id !== item.id));
      } catch {
        setResults([]);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [query, item.id]);

  async function submit() {
    if (!selected) {
      setError("Pilih dulu barang pasangannya.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api.post("/duplicate-reports", { item_a_id: item.id, item_b_id: selected.id, note });
      window.dispatchEvent(new Event("duplicate-reports-changed"));
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Gagal mengirim laporan.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={`Laporkan duplikat: ${item.name}`} onClose={onClose}>
      <p className="muted small">
        Barang ini terindikasi sama dengan barang lain di katalog. Laporan masuk ke antrean Duplikat untuk
        diputuskan Admin — katalog tidak berubah sampai Admin ACC.
      </p>
      <label className="field">
        <span>Cari barang pasangannya (kode / nama)</span>
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="mis. RANTAI BESI SS304 3MM" autoFocus />
      </label>
      {results.length > 0 && (
        <ul className="list" style={{ gap: 4, maxHeight: 200, overflow: "auto" }}>
          {results.map((r) => (
            <li key={r.id}>
              <button
                className={`btn small ${selected?.id === r.id ? "primary" : "ghost"}`}
                style={{ width: "100%", justifyContent: "flex-start", textAlign: "left" }}
                onClick={() => setSelected(r)}
              >
                {r.name} <span className="muted">({r.code || "tanpa kode"})</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {selected && (
        <p className="small">
          Pasangan: <strong>{selected.name}</strong> ({selected.code || "tanpa kode"})
        </p>
      )}
      <label className="field">
        <span>Catatan (opsional)</span>
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="mis. sama persis, beda spasi saja" />
      </label>
      {error && <p className="small" style={{ color: "var(--danger)" }}>{error}</p>}
      <div className="row" style={{ justifyContent: "flex-end" }}>
        <button className="btn ghost" onClick={onClose}>Batal</button>
        <button className="btn primary" disabled={busy} onClick={() => void submit()}>
          {busy ? "Mengirim…" : "Kirim laporan"}
        </button>
      </div>
    </Modal>
  );
}
