import { useState } from "react";
import { Modal } from "./Modal";
import { api } from "../api";
import type { CatalogItem } from "@shared/types";

/* "Tandai duplikat" dari barang yang dicentang di Katalog (2 barang atau lebih).
 * Semua barang yang dicentang jadi satu laporan kelompok; Admin memilih satu yang dipakai.
 * Laporan masuk ke Gudang > Menunggu ACC Duplikat; katalog tidak berubah sampai Admin ACC. */

export default function ReportDuplicateModal({
  items,
  onClose,
  onSent,
}: {
  items: CatalogItem[];
  onClose: () => void;
  onSent: () => void;
}) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit() {
    setBusy(true);
    setError("");
    try {
      await api.post("/duplicate-reports", { item_ids: items.map((i) => i.id), note });
      window.dispatchEvent(new Event("duplicate-reports-changed"));
      onSent();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Gagal mengirim laporan.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Tandai duplikat"
      sub={`${items.length} barang dianggap satu barang yang sama`}
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>Batal</button>
          <button className="btn primary" disabled={busy || items.length < 2} onClick={() => void submit()}>
            {busy ? "Mengirim…" : "Kirim ke Menunggu ACC Duplikat"}
          </button>
        </>
      }
    >
      <div style={{ display: "grid", gap: 8, marginBottom: 12 }}>
        {items.map((item) => (
          <div key={item.id}>
            <strong>{item.name}</strong> <span className="muted num">· {item.code || "tanpa kode"}</span>
            <span className="muted small"> · {[item.category, item.uom].filter(Boolean).join(" · ")}</span>
          </div>
        ))}
      </div>
      <label className="field">
        <span>Catatan (opsional)</span>
        <input
          className="input"
          value={note}
          maxLength={500}
          onChange={(e) => setNote(e.target.value)}
          placeholder="mis. sama persis, beda spasi saja"
        />
      </label>
      <p className="muted small">Admin memilih barang yang dipakai di Gudang. Katalog tidak berubah sampai di-ACC.</p>
      {error && <p className="small" role="alert" style={{ color: "var(--color-danger, #c62828)" }}>{error}</p>}
    </Modal>
  );
}
