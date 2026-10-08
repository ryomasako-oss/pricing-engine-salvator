/* "Barang baru": an item that isn't in Accurate yet (shared/pendingItems.ts).
   It is requested here and its line goes on the quote held ("Menunggu
   Accurate"), so the rest of the quote isn't kept waiting. A manager hands
   the request to Accurate later; the line is released once the catalog has the code. */

import { useState } from "react";
import { api } from "../api";
import type { CatalogItem, QuoteItem } from "@shared/types";
import type { PendingItem } from "@shared/pendingItems";
import { lineFromCatalog } from "@shared/match";
import { Modal } from "./Modal";

export function NewItemForm({
  uomOptions,
  initialName,
  onBack,
  onClose,
  onCreated,
}: {
  uomOptions: string[];
  initialName: string;
  onBack: () => void;
  onClose: () => void;
  /** The held quote line for the new item. */
  onCreated: (line: QuoteItem) => void;
}) {
  const [name, setName] = useState(initialName);
  const [uom, setUom] = useState("Pcs");
  const [price, setPrice] = useState("");
  const [qty, setQty] = useState("1");
  const [code, setCode] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      const r = await api.post<{ item: PendingItem }>("/pending-items", {
        name,
        uom,
        proposed_price: Number(price) || 0,
        note,
        ...(code.trim() ? { code: code.trim() } : {}),
      });
      const it = r.item;
      const row: CatalogItem = {
        id: -it.id, code: it.code, name: it.name, uom: it.uom, cogs: 0, list_price: it.proposed_price,
        stock: 0, category: "", source: "pending", updated_at: it.created_at,
      };
      // Held right away; the server holds it on every read too, until the catalog has the code.
      onCreated({ ...lineFromCatalog(row, Math.max(1, Number(qty) || 1)), held: true, holdReason: "new_item" });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const options = uomOptions.includes(uom) ? uomOptions : [uom, ...uomOptions];

  return (
    <Modal
      title="Barang baru"
      sub="Belum ada di Accurate. Barisnya ditahan di quotation sampai barangnya dibuat di Accurate; quotation lainnya tetap jalan."
      onClose={onClose}
      footer={
        <>
          <span className="grow" />
          <button className="btn ghost" onClick={onBack} disabled={busy}>Kembali</button>
          <button className="btn primary" onClick={submit} disabled={busy || name.trim().length < 2}>
            Buat &amp; tambahkan
          </button>
        </>
      }
    >
      <div style={{ display: "grid", gap: 10 }}>
        <label className="field">
          <span className="small">Nama barang</span>
          <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Nama lengkap, mis. merek dan ukuran" />
        </label>
        <div className="row-wrap" style={{ gap: 10 }}>
          <label className="field" style={{ flex: 1, minWidth: 120 }}>
            <span className="small">Satuan</span>
            <select className="input" value={uom} onChange={(e) => setUom(e.target.value)}>
              {options.map((u) => (
                <option key={u} value={u}>{u}</option>
              ))}
            </select>
          </label>
          <label className="field" style={{ flex: 1, minWidth: 120 }}>
            <span className="small">Qty</span>
            <input className="input" type="number" min="1" value={qty} onChange={(e) => setQty(e.target.value)} />
          </label>
          <label className="field" style={{ flex: 2, minWidth: 160 }}>
            <span className="small">Perkiraan harga jual (opsional)</span>
            <input className="input" type="number" min="0" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="0" />
          </label>
        </div>
        <label className="field">
          <span className="small">Kode di Accurate (opsional)</span>
          <input className="input" value={code} onChange={(e) => setCode(e.target.value)} placeholder="Kosongkan kalau belum tahu; kode sementara BARU-0001 akan dibuat" />
        </label>
        <label className="field">
          <span className="small">Catatan untuk yang membuat di Accurate (opsional)</span>
          <input className="input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
        </label>
        {error && <p className="notice warn small">{error}</p>}
      </div>
    </Modal>
  );
}
