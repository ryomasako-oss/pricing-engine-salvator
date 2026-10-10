/* "Barang baru" waiting for Accurate (shared/pendingItems.ts), for managers:
   hand a request to Accurate (opens a task and gives the admin an Excel to
   copy from), or cancel it. Nothing is written to Accurate from here. */

import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { useToast } from "../context/ToastContext";
import { Icon } from "./Icon";
import { exportPendingItems } from "../export/pendingItems";
import { fmtDateTime, grp } from "@shared/format";
import type { PendingItem } from "@shared/pendingItems";

const STATUS: Record<PendingItem["status"], { label: string; tone: string }> = {
  draft: { label: "Belum diajukan", tone: "amber" },
  submitted: { label: "Diajukan ke Accurate", tone: "blue" },
  linked: { label: "Sudah di katalog", tone: "green" },
  cancelled: { label: "Dibatalkan", tone: "grey" },
};

export function PendingItemsPanel() {
  const toast = useToast();
  const [items, setItems] = useState<PendingItem[] | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  const load = useCallback(() => {
    api.get<{ items: PendingItem[] }>("/pending-items").then((r) => setItems(r.items)).catch(() => setItems(null));
  }, []);
  useEffect(load, [load]);

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
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-head">
        <h3>Barang baru menunggu Accurate</h3>
        <span className="muted small">
          {live.length ? `${grp(live.length)} permintaan aktif` : "Tidak ada yang aktif"}. Quotation yang memakainya tetap jalan; barisnya ditahan sampai barangnya masuk katalog.
        </span>
      </div>
      <div className="card-body">
        {live.length > 0 && (
          <div className="row-wrap" style={{ marginBottom: 10 }}>
            <button className="btn small ghost" onClick={() => exportPendingItems(live, new Date().toISOString().slice(0, 10))}>
              <Icon name="download" size={13} /> Unduh Excel untuk admin Accurate
            </button>
            <span className="muted small">Buat di Accurate dengan kode persis seperti di daftar, lalu sinkron dan Terapkan (pilih tambahkan barang baru).</span>
          </div>
        )}
        <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 8 }}>
          {items.map((i) => (
            <li key={i.id} className="row-wrap" style={{ justifyContent: "space-between", gap: 8 }}>
              <div>
                <strong>{i.name}</strong> <span className="muted">· {i.code} · {i.uom}</span>{" "}
                <span className={`badge ${STATUS[i.status].tone}`}>{STATUS[i.status].label}</span>
                <div className="muted small">
                  {i.requested_by_name ? `Diminta ${i.requested_by_name}, ` : ""}
                  {fmtDateTime(i.created_at)}
                  {i.proposed_price > 0 ? ` · perkiraan Rp ${grp(i.proposed_price)}` : ""}
                  {i.note ? ` · ${i.note}` : ""}
                </div>
              </div>
              {(i.status === "draft" || i.status === "submitted") && (
                <div className="row-wrap">
                  {i.status === "draft" && (
                    <button className="btn small" disabled={busy === i.id} onClick={() => act(i, "submit")}>
                      Ajukan ke Accurate
                    </button>
                  )}
                  <button className="btn small ghost" disabled={busy === i.id} onClick={() => act(i, "cancel")}>
                    Batalkan
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
