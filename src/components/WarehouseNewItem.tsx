/* Katalog › "Barang baru": an item that is in the warehouse but not in Accurate yet. Warehouse staff
   register it with its units and a barcode per unit. It becomes a "barang baru" request
   (shared/pendingItems.ts): nothing goes to Accurate, extra units wait for a manager, and the barcodes
   follow the item into the catalog once Accurate has it (same code, or linked by a manager).
   Server: POST /pending-items. */

import { useEffect, useState } from "react";
import { api } from "../api";
import { useToast } from "../context/ToastContext";
import { Icon } from "./Icon";
import { Modal } from "./Modal";
import type { CatalogItem } from "@shared/types";
import type { PendingItem } from "@shared/pendingItems";
import { sameUom } from "@shared/uom";

interface UnitRow {
  uom: string;
  count: string;
  barcode: string;
  generate: boolean;
}

const emptyUnit = (): UnitRow => ({ uom: "", count: "", barcode: "", generate: false });
const num = (s: string) => Number(s.replace(",", "."));

export function WarehouseNewItem({
  uomOptions,
  onClose,
  onCreated,
}: {
  uomOptions: string[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const toast = useToast();
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [base, setBase] = useState<UnitRow>({ uom: "Pcs", count: "1", barcode: "", generate: false });
  const [units, setUnits] = useState<UnitRow[]>([]);
  const [note, setNote] = useState("");
  const [similar, setSimilar] = useState<CatalogItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Items already in the catalog with a similar name, so a twin is caught before it is requested.
  useEffect(() => {
    const q = name.trim();
    if (q.length < 3) return setSimilar([]);
    const t = setTimeout(() => {
      api
        .get<{ items: CatalogItem[] }>(`/catalog?q=${encodeURIComponent(q)}&limit=5`)
        .then((r) => setSimilar(r.items))
        .catch(() => setSimilar([]));
    }, 300);
    return () => clearTimeout(t);
  }, [name]);

  const setUnit = (i: number, patch: Partial<UnitRow>) => setUnits(units.map((u, k) => (k === i ? { ...u, ...patch } : u)));
  const filledUnits = units.filter((u) => u.uom.trim() || u.count.trim() || u.barcode.trim());
  const unitsOk = filledUnits.every((u) => u.uom.trim() && num(u.count) > 0);
  const ready = name.trim().length >= 2 && base.uom.trim() && unitsOk && !busy;

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    const all = [base, ...filledUnits];
    try {
      const r = await api.post<{ item: PendingItem }>("/pending-items", {
        name: name.trim(),
        uom: base.uom.trim(),
        note: note.trim(),
        ...(code.trim() && { code: code.trim() }),
        units: filledUnits.map((u) => ({ uom: u.uom.trim(), factor: num(u.count) })),
        barcodes: all
          .filter((u) => u.barcode.trim() || u.generate)
          .map((u) => ({ uom: u.uom.trim(), ...(u.barcode.trim() ? { barcode: u.barcode.trim() } : { generate: true }) })),
      });
      toast(`${r.item.name} tercatat sebagai barang baru ${r.item.code}. Menunggu dibuat di Accurate.`, "success");
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Gagal menyimpan barang baru.");
    } finally {
      setBusy(false);
    }
  };

  const unitNames = uomOptions.filter((o) => !sameUom(o, base.uom));
  return (
    <Modal
      title="Barang baru (belum ada di Accurate)"
      sub="Untuk barang yang ada di gudang tetapi belum ada di katalog. Data ini tidak dikirim ke Accurate."
      onClose={onClose}
      size="wide"
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>Batal</button>
          <button className="btn primary" disabled={!ready} onClick={() => void submit()}>
            {busy ? "Menyimpan…" : "Simpan barang baru"}
          </button>
        </>
      }
    >
      <form
        className="unit-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label className="field">
          <span>Nama barang</span>
          <input className="input" autoFocus maxLength={200} placeholder="Mis. ARTLINE EK-6666 GREEN" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        {similar.length > 0 && (
          <div className="notice warn">
            <strong>Mirip dengan barang di katalog. Pastikan bukan barang yang sama:</strong>
            <ul className="similar-list">
              {similar.map((s) => (
                <li key={s.code}>
                  <span className="num">{s.code}</span> · {s.name} · {s.uom}
                </li>
              ))}
            </ul>
          </div>
        )}
        <label className="field">
          <span>Kode Accurate (boleh dikosongkan)</span>
          <input className="input" maxLength={64} placeholder="Kosong = diberi kode BARU-…" value={code} onChange={(e) => setCode(e.target.value)} />
        </label>

        <div className="field">
          <span>Satuan dan barcode</span>
          <div className="new-units">
            <div className="new-unit">
              <input
                className="input"
                list="new-item-units"
                maxLength={32}
                value={base.uom}
                onChange={(e) => setBase({ ...base, uom: e.target.value })}
                aria-label="Satuan dasar (terkecil)"
              />
              <span className="muted small new-unit-ratio">satuan dasar (terkecil)</span>
              <BarcodeInput row={base} label={`Barcode ${base.uom || "satuan dasar"}`} onChange={(p) => setBase({ ...base, ...p })} />
            </div>
            {units.map((u, i) => (
              <div key={i} className="new-unit">
                <input
                  className="input"
                  list="new-item-units"
                  maxLength={32}
                  placeholder="Mis. Box"
                  value={u.uom}
                  onChange={(e) => setUnit(i, { uom: e.target.value })}
                  aria-label={`Satuan tambahan ${i + 1}`}
                />
                <span className="new-unit-ratio">
                  isi
                  <input
                    className="input num"
                    inputMode="decimal"
                    placeholder="0"
                    value={u.count}
                    onChange={(e) => setUnit(i, { count: e.target.value })}
                    aria-label={`Isi ${u.uom || "satuan tambahan"} dalam ${base.uom}`}
                  />
                  {base.uom}
                </span>
                <BarcodeInput row={u} label={`Barcode ${u.uom || "satuan tambahan"}`} onChange={(p) => setUnit(i, p)} />
                <button type="button" className="icon-btn" onClick={() => setUnits(units.filter((_, k) => k !== i))} aria-label={`Hapus satuan ${u.uom}`} title="Hapus">
                  <Icon name="trash" size={15} />
                </button>
              </div>
            ))}
            <button type="button" className="btn small ghost new-unit-add" onClick={() => setUnits([...units, emptyUnit()])} disabled={units.length >= 9}>
              <Icon name="plus" size={14} /> Satuan lebih besar (Box, Dus, …)
            </button>
          </div>
          <datalist id="new-item-units">
            {unitNames.map((o) => (
              <option key={o} value={o} />
            ))}
          </datalist>
        </div>

        <label className="field">
          <span>Catatan (boleh dikosongkan)</span>
          <input className="input" maxLength={500} placeholder="Mis. ditemukan di rak B3, 40 pcs" value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        <p className="muted small">
          Tercatat sebagai barang baru yang menunggu dibuat di Accurate. Satuan tambahan diperiksa manager dulu. Barcodenya ikut masuk
          katalog begitu barang ini ada di Accurate.
        </p>
        {error && <div className="text-err small" role="alert">{error}</div>}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

/** A barcode box (scan or type), or "buatkan" when the packaging has none. */
function BarcodeInput({ row, label, onChange }: { row: UnitRow; label: string; onChange: (p: Partial<UnitRow>) => void }) {
  return (
    <span className="new-unit-barcode">
      <input
        className="input"
        inputMode="numeric"
        maxLength={64}
        placeholder={row.generate ? "Dibuatkan saat disimpan" : "Scan / ketik barcode"}
        value={row.barcode}
        disabled={row.generate}
        onChange={(e) => onChange({ barcode: e.target.value })}
        aria-label={label}
      />
      <label className="check small">
        <input type="checkbox" checked={row.generate} onChange={(e) => onChange({ generate: e.target.checked, barcode: "" })} /> Buatkan
      </label>
    </span>
  );
}
