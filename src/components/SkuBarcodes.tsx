/* Katalog › Barcode per satuan. One row per SKU (item + unit): the base unit, its extra units, units
   proposed by warehouse staff (waiting for a manager; quotes don't use them), and any unit that only
   still has a barcode. Every role may fill these in; warehouse accounts are usually `rep`.
   Server: PUT /catalog/:id/barcode, POST /catalog/:id/barcode/generate, POST /catalog/:id/unit. */

import { useRef, useState } from "react";
import { api } from "../api";
import { useAuth } from "../context/AuthContext";
import { useToast } from "../context/ToastContext";
import { Icon } from "./Icon";
import { ConfirmModal, Modal } from "./Modal";
import type { CatalogItem, UnitBarcode, UnitFactor } from "@shared/types";
import { ratioText, sameUom } from "@shared/uom";

/** What the server answers after a change to one item's units or barcodes. */
export interface SkuPatch {
  units: UnitFactor[];
  barcodes: UnitBarcode[];
  proposals: UnitFactor[];
}

/** Every SKU of an item: base unit, extra units, proposals, and units that only still have a barcode. */
function skuRows(item: CatalogItem) {
  const rows: { uom: string; note: string; pending?: boolean }[] = [
    { uom: item.uom, note: "satuan dasar" },
    ...(item.units ?? []).map((u) => ({ uom: u.uom, note: ratioText(u.uom, u.factor, item.uom) })),
    ...(item.unit_proposals ?? []).map((u) => ({ uom: u.uom, note: ratioText(u.uom, u.factor, item.uom), pending: true })),
  ];
  const barcodes = item.barcodes ?? [];
  // A barcode whose unit has gone (e.g. Accurate dropped the ratio) still shows, so it can be removed.
  for (const b of barcodes) if (!rows.some((r) => sameUom(r.uom, b.uom))) rows.push({ uom: b.uom, note: "rasio tidak ada" });
  return rows.map((r) => ({ ...r, saved: barcodes.find((b) => sameUom(b.uom, r.uom)) }));
}

/** "2/4": units with a barcode out of all units, for the row's expand button. */
export function skuProgress(item: CatalogItem): { filled: number; total: number } {
  const rows = skuRows(item);
  return { filled: rows.filter((r) => r.saved).length, total: rows.length };
}

/**
 * The opened catalog row: one small card per unit (unit and ratio, then its barcode box), and
 * Tambah satuan. Enter in a box saves it and goes on to the next unit, for a scanner.
 */
export function SkuPanel({
  item,
  uomOptions,
  onChange,
  onUomAdded,
}: {
  item: CatalogItem;
  uomOptions: string[];
  onChange: (patch: SkuPatch) => void;
  onUomAdded: () => void;
}) {
  const [adding, setAdding] = useState(false);
  return (
    <div className="sku-panel">
      <div className="sku-panel-head">
        <strong>Barcode per satuan</strong>
        <span className="muted small">Scan lalu Enter untuk lanjut ke satuan berikutnya.</span>
        <button className="btn small ghost" onClick={() => setAdding(true)}>
          <Icon name="plus" size={14} /> Tambah satuan
        </button>
      </div>
      <div className="sku-list">
        {skuRows(item).map((r) => (
          <div key={r.uom} className="sku-row">
            <div className="sku-head">
              <strong>{r.uom}</strong>
              <span className="muted small">{r.note}</span>
              {r.pending && <span className="badge amber">menunggu persetujuan</span>}
              {r.saved?.generated && <span className="badge grey">buatan sistem</span>}
            </div>
            <BarcodeCell key={`${r.uom}:${r.saved?.barcode ?? ""}`} item={item} uom={r.uom} saved={r.saved?.barcode ?? ""} onChange={onChange} />
          </div>
        ))}
      </div>
      {adding && (
        <AddUnitModal
          item={item}
          uomOptions={uomOptions}
          onClose={() => setAdding(false)}
          onAdded={(patch) => {
            onChange(patch);
            onUomAdded();
            setAdding(false);
          }}
        />
      )}
    </div>
  );
}

/**
 * The barcode of one SKU, typed or scanned.
 * Empty: the box saves on Enter or on leaving it, and Enter jumps to the next box, so a scanner can go
 * down the list; "Buat barcode" gives an internal one when the packaging has none. A saved barcode is
 * locked: Ubah opens it, only Simpan saves the change, and only Hapus (confirmed) removes it, so
 * emptying the box never wipes it.
 */
function BarcodeCell({
  item,
  uom,
  saved,
  onChange,
}: {
  item: CatalogItem;
  uom: string;
  saved: string;
  onChange: (patch: SkuPatch) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(saved);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // The value that failed, so leaving the box again does not resend it.
  const failed = useRef<string | null>(null);
  const next = value.trim();
  const changed = next !== saved;

  const call = async (request: () => Promise<SkuPatch>, sent: string | null): Promise<boolean> => {
    if (busy) return false;
    setBusy(true);
    try {
      onChange(await request());
      return true;
    } catch (e) {
      failed.current = sent;
      setError(e instanceof Error ? e.message : "Gagal menyimpan barcode.");
      return false;
    } finally {
      setBusy(false);
    }
  };
  const send = (barcode: string, clear = false) =>
    call(() => api.put<SkuPatch>(`/catalog/${item.id}/barcode`, { uom, barcode, ...(clear && { clear }) }), barcode);
  const generate = () => call(() => api.post<SkuPatch>(`/catalog/${item.id}/barcode/generate`, { uom }), null);
  /** Saves a non-empty, changed value; an empty box is never sent as a delete. */
  const save = () => (next && changed && next !== failed.current ? send(next) : Promise.resolve(false));
  const cancel = () => {
    setValue(saved);
    setEditing(false);
    setError(null);
    failed.current = null;
  };

  if (saved && !editing) {
    return (
      <div className="barcode-row">
        <span className="num grow">{saved}</span>
        <span className="badge green barcode-ok">
          <Icon name="check" size={14} />
          Tersimpan
        </span>
        <button className="btn small ghost" onClick={() => setEditing(true)}>Ubah barcode</button>
      </div>
    );
  }

  return (
    <div className="barcode-cell">
      <div className="barcode-line">
        <input
          className={`input${error ? " invalid" : changed && next ? " dirty" : ""}`}
          data-barcode
          inputMode="numeric"
          maxLength={64}
          placeholder="Scan / ketik"
          aria-label={`Barcode ${item.name} per ${uom}`}
          aria-invalid={!!error}
          autoFocus={editing}
          value={value}
          readOnly={busy}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
            failed.current = null;
          }}
          // A saved barcode being changed waits for Simpan; a first fill saves on leaving the box.
          onBlur={() => !editing && void save()}
          onKeyDown={async (e) => {
            if (e.key === "Escape") return cancel();
            if (e.key !== "Enter") return;
            e.preventDefault();
            const all = [...document.querySelectorAll<HTMLInputElement>("input[data-barcode]")];
            const after = all[all.indexOf(e.currentTarget) + 1];
            if ((await save()) && !editing) after?.focus();
          }}
        />
        {/* Buttons sit beside the box; they wrap under it on a narrow screen. */}
        <div className="barcode-row">
          {busy ? (
            <span className="muted small">Menyimpan…</span>
          ) : (
            <>
              {(editing || (changed && next)) && (
                // mousedown keeps focus in the box, so leaving it does not save a second time.
                <button className="btn small" disabled={!next || !changed} onMouseDown={(e) => e.preventDefault()} onClick={() => void save()}>
                  Simpan
                </button>
              )}
              {!saved && !next && (
                <button className="btn small ghost" onClick={() => void generate()} title="Untuk barang yang kemasannya tidak ada barcode">
                  Buat barcode
                </button>
              )}
              {editing && (
                <>
                  <button className="btn small ghost" onClick={cancel}>Batal</button>
                  <button className="btn small ghost danger" onClick={() => setConfirmDelete(true)}>Hapus barcode</button>
                </>
              )}
            </>
          )}
        </div>
      </div>
      {error && <div className="text-err small" role="alert">{error}</div>}
      {confirmDelete && (
        <ConfirmModal
          title="Hapus barcode saja?"
          message={
            <>
              Yang dihapus hanya barcode <b className="num">{saved}</b> untuk satuan {uom}. Barangnya ({item.code}, {item.name})
              tetap ada di katalog beserta satuan, harga, stok, dan fotonya.
            </>
          }
          confirmLabel="Ya, hapus barcode"
          busy={busy}
          onClose={() => setConfirmDelete(false)}
          onConfirm={async () => {
            if (await send("", true)) setConfirmDelete(false);
          }}
        />
      )}
    </div>
  );
}

/** Warehouse staff add a unit the item lacks, bigger (1 Box = 24 Pcs) or smaller (1 Lusin = 12 Pcs). */
function AddUnitModal({
  item,
  uomOptions,
  onClose,
  onAdded,
}: {
  item: CatalogItem;
  uomOptions: string[];
  onClose: () => void;
  onAdded: (patch: SkuPatch) => void;
}) {
  const toast = useToast();
  const direct = useAuth().can("edit_catalog");
  const [smaller, setSmaller] = useState(false);
  const [uom, setUom] = useState("");
  const [count, setCount] = useState("");
  const [barcode, setBarcode] = useState("");
  const [generate, setGenerate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const n = Number(count.replace(",", "."));
  const name = uom.trim() || "…";
  const known = [item.uom, ...(item.units ?? []).map((u) => u.uom), ...(item.unit_proposals ?? []).map((u) => u.uom)];
  const choices = uomOptions.filter((o) => !known.some((k) => sameUom(k, o)));
  const ready = uom.trim() && n > 0 && !busy;

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const patch = await api.post<SkuPatch>(`/catalog/${item.id}/unit`, {
        uom: uom.trim(),
        factor: smaller ? 1 / n : n,
        ...(barcode.trim() ? { barcode: barcode.trim() } : generate ? { generate: true } : {}),
      });
      // The server may have used the list's spelling ("pcs" -> "Pcs").
      const added = [...patch.units, ...patch.proposals].find((u) => sameUom(u.uom, uom.trim()))?.uom ?? uom.trim();
      toast(
        direct ? `Satuan ${added} ditambahkan.` : `Satuan ${added} diusulkan. Quotation baru memakainya setelah disetujui manager.`,
        "success",
      );
      onAdded(patch);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Gagal menambah satuan.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Tambah satuan"
      sub={`${item.code} · ${item.name} · satuan dasar ${item.uom}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>Batal</button>
          <button className="btn" disabled={!ready} onClick={() => void submit()}>
            {busy ? "Menyimpan…" : "Simpan satuan"}
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
        <fieldset className="field unit-dir">
          <legend>Satuan baru ini</legend>
          <label>
            <input type="radio" name="dir" checked={!smaller} onChange={() => setSmaller(false)} /> Lebih besar dari {item.uom} (mis. Box, Dus)
          </label>
          <label>
            <input type="radio" name="dir" checked={smaller} onChange={() => setSmaller(true)} /> Lebih kecil dari {item.uom} (mis. Pcs, Lembar)
          </label>
        </fieldset>
        <label className="field">
          <span>Nama satuan</span>
          <input
            className="input"
            list="unit-choices"
            autoFocus
            maxLength={32}
            placeholder="Pilih atau ketik satuan baru"
            value={uom}
            onChange={(e) => setUom(e.target.value)}
          />
          <datalist id="unit-choices">
            {choices.map((o) => (
              <option key={o} value={o} />
            ))}
          </datalist>
        </label>
        <label className="field">
          <span>Isi</span>
          <div className="unit-ratio">
            <span>1 {smaller ? item.uom : name} =</span>
            <input
              className="input num"
              inputMode="decimal"
              placeholder="0"
              value={count}
              onChange={(e) => setCount(e.target.value)}
              aria-label="Jumlah isi"
            />
            <span>{smaller ? name : item.uom}</span>
          </div>
        </label>
        <label className="field">
          <span>Barcode {name} (boleh dikosongkan)</span>
          <input
            className="input"
            inputMode="numeric"
            maxLength={64}
            placeholder="Scan / ketik dari kemasan"
            value={barcode}
            onChange={(e) => setBarcode(e.target.value)}
          />
        </label>
        {!barcode.trim() && (
          <label className="check">
            <input type="checkbox" checked={generate} onChange={(e) => setGenerate(e.target.checked)} /> Kemasan tidak ada barcode: buatkan barcode
          </label>
        )}
        <p className="muted small">
          {direct
            ? "Satuan ini langsung dipakai quotation. "
            : "Satuan ini diperiksa manager dulu. Sebelum disetujui, quotation tetap memakai satuan dari Accurate. "}
          Data ini tidak dikirim ke Accurate.
        </p>
        {error && <div className="text-err small" role="alert">{error}</div>}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
