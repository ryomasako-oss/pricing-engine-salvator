/* "Barang baru" waiting for Accurate (shared/pendingItems.ts). Everyone sees their own requests
   (managers see all) with the barcodes and units warehouse staff filled in. Managers hand a request
   to Accurate (opens a task and gives the admin an Excel to copy from), link it to the code Accurate
   actually used, or cancel it. Nothing is written to Accurate from here. */

import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { useAuth } from "../context/AuthContext";
import { useToast } from "../context/ToastContext";
import { Modal } from "./Modal";
import { ratioText } from "@shared/uom";
import { fmtDateTime, grp } from "@shared/format";
import type { PendingItem } from "@shared/pendingItems";

const STATUS: Record<PendingItem["status"], { label: string; tone: string }> = {
  draft: { label: "Belum diajukan", tone: "amber" },
  submitted: { label: "Diajukan ke Accurate", tone: "blue" },
  linked: { label: "Sudah di katalog", tone: "green" },
  cancelled: { label: "Dibatalkan", tone: "grey" },
};

export function PendingItemsPanel({ reload = 0, onLinked }: { reload?: number; onLinked?: () => void }) {
  const toast = useToast();
  const manage = useAuth().can("edit_catalog");
  const [items, setItems] = useState<PendingItem[] | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [linking, setLinking] = useState<PendingItem | null>(null);

  const load = useCallback(() => {
    api.get<{ items: PendingItem[] }>("/pending-items").then((r) => setItems(r.items)).catch(() => setItems(null));
  }, []);
  useEffect(load, [load, reload]);

  if (!items) return null;
  const live = items.filter((i) => i.status === "draft" || i.status === "submitted");
  if (!items.length) return null;

  const act = async (item: PendingItem, what: "submit" | "cancel") => {
    setBusy(item.id);
    try {
      await api.post(`/pending-items/${item.id}/${what}`);
      toast(what === "submit" ? `${item.code} diajukan ke Accurate. Tugasnya ada di Perlu diperbaiki.` : `${item.code} dibatalkan.`);
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(null);
      load();
    }
  };

  return (
    <div className="card">
      <div className="card-head">
        <h3>Barang baru menunggu Accurate</h3>
        <span className="muted small">
          {live.length ? `${grp(live.length)} permintaan aktif` : "Tidak ada yang aktif"}. Quotation yang memakainya tetap jalan. Barisnya ditahan sampai barangnya masuk katalog.
        </span>
      </div>
      <div className="card-body">
        {manage && live.length > 0 && (
          <div className="row-wrap card-lead">
            <button className="btn small ghost" onClick={async () => (await import("../export/pendingItems")).exportPendingItems(live, new Date().toISOString().slice(0, 10))}>
              Unduh Excel untuk admin Accurate
            </button>
            <span className="muted small">Buat di Accurate dengan kode yang sama persis, lalu sinkron dan klik Terapkan (pilih tambahkan barang baru).</span>
          </div>
        )}
        <ul className="list-stack">
          {items.map((i) => (
            <li key={i.id} className="row-between">
              <div>
                <strong>{i.name}</strong> <span className="muted">· {i.code} · {i.uom}</span>{" "}
                <span className={`badge ${STATUS[i.status].tone}`}>{STATUS[i.status].label}</span>
                <div className="muted small">
                  {i.requested_by_name ? `Diminta ${i.requested_by_name}, ` : ""}
                  {fmtDateTime(i.created_at)}
                  {i.proposed_price > 0 ? ` · perkiraan Rp ${grp(i.proposed_price)}` : ""}
                  {i.note ? ` · ${i.note}` : ""}
                  {i.linked_code && i.linked_code !== i.code ? ` · dibuat di Accurate sebagai ${i.linked_code}` : ""}
                </div>
                {(!!i.units?.length || !!i.barcodes?.length) && (
                  <div className="badge-row pending-skus">
                    {i.units?.map((u) => (
                      <span key={`u:${u.uom}`} className="badge grey num">{ratioText(u.uom, u.factor, i.uom)}</span>
                    ))}
                    {i.barcodes?.map((b) => (
                      <span key={`b:${b.uom}`} className="badge green num">{b.uom}: {b.barcode}</span>
                    ))}
                  </div>
                )}
              </div>
              {manage && (i.status === "draft" || i.status === "submitted") && (
                <div className="row-wrap">
                  {i.status === "draft" && (
                    <button className="btn small" disabled={busy === i.id} onClick={() => act(i, "submit")}>
                      Ajukan ke Accurate
                    </button>
                  )}
                  <button className="btn small ghost" disabled={busy === i.id} onClick={() => setLinking(i)}>
                    Sambungkan ke kode Accurate
                  </button>
                  <button className="btn small ghost" disabled={busy === i.id} onClick={() => act(i, "cancel")}>
                    Batalkan
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </div>
      {linking && (
        <LinkDialog
          item={linking}
          onClose={() => setLinking(null)}
          onDone={() => {
            setLinking(null);
            load();
            onLinked?.();
          }}
        />
      )}
    </div>
  );
}

/** Accurate created the item under another code: move the request (and its barcodes) to that code. */
function LinkDialog({ item, onClose, onDone }: { item: PendingItem; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (!code.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ target: { code: string; name: string }; dropped: { uom: string; barcode: string }[] }>(
        `/pending-items/${item.id}/link`,
        { code: code.trim() },
      );
      const kept = r.dropped.length ? ` Barcode ${r.dropped.map((d) => `${d.uom} ${d.barcode}`).join(", ")} tidak dipindah karena barang itu sudah punya barcode untuk satuan tersebut.` : "";
      toast(`${item.code} disambungkan ke ${r.target.code} (${r.target.name}).${kept}`, "success");
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Gagal menyambungkan.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Sambungkan ke kode Accurate"
      sub={`${item.code} · ${item.name}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>Batal</button>
          <button className="btn primary" disabled={!code.trim() || busy} onClick={() => void submit()}>
            {busy ? "Menyambungkan…" : "Sambungkan"}
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
          <span>Kode barang di Accurate</span>
          <input className="input" autoFocus maxLength={64} placeholder="Mis. 80801999" value={code} onChange={(e) => setCode(e.target.value)} />
        </label>
        <p className="muted small">
          Barangnya harus sudah masuk katalog (sinkron lalu Terapkan data Accurate). Barcode dan usulan satuan dari gudang pindah ke kode
          itu, dan pengajuan ini ditutup.
        </p>
        {error && <div className="text-err small" role="alert">{error}</div>}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
