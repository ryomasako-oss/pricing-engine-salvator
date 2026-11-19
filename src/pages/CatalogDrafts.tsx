/* Draf Perbaikan Divisi Gudang (2026-11-19): what an Admin Gudang changed in Katalog (barcode, Buat barcode,
   Tambah satuan, Ubah barang), waiting for an admin. ACC applies it to the catalog; Tolak needs a reason.
   The Admin Gudang sees their own drafts here and can take one back. Server: /catalog/drafts. */

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { LoadError } from "../components/LoadError";
import { Modal } from "../components/Modal";
import { useAuth } from "../context/AuthContext";
import { useToast } from "../context/ToastContext";
import { useNavCounts } from "../context/NavCountsContext";
import { fmtDateTime, grp } from "@shared/format";
import { draftChanges } from "@shared/catalogDrafts";
import type { CatalogDraftMark } from "@shared/types";

interface DraftRow {
  id: number;
  code: string;
  name: string | null;
  kind: CatalogDraftMark["kind"];
  uom: string;
  payload: Record<string, unknown>;
  before: Record<string, unknown>;
  status: "pending" | "approved" | "rejected" | "cancelled";
  note: string;
  created_by_name: string | null;
  created_at: string;
  reviewed_by_name: string | null;
  reviewed_at: string | null;
}

const KIND_LABEL: Record<DraftRow["kind"], string> = { barcode: "Barcode", unit: "Satuan baru", edit: "Ubah barang" };
const STATUS: Record<Exclude<DraftRow["status"], "pending">, [string, string]> = {
  approved: ["green", "Di-ACC"],
  rejected: ["red", "Ditolak"],
  cancelled: ["grey", "Dibatalkan"],
};
const changed = () => window.dispatchEvent(new Event("catalog-drafts-changed"));

export function CatalogDraftsPage() {
  const toast = useToast();
  const { can } = useAuth();
  const reviewer = can("review_catalog_drafts");
  const { drafts: waiting } = useNavCounts();
  const [status, setStatus] = useState<"pending" | "done">("pending");
  const [rows, setRows] = useState<DraftRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [rejecting, setRejecting] = useState<DraftRow | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const loadSeq = useRef(0);
  const load = useCallback(() => {
    const seq = ++loadSeq.current;
    setLoading(true);
    setLoadError(null);
    setPicked(new Set());
    api
      .get<{ drafts: DraftRow[] }>(`/catalog/drafts?status=${status}`)
      .then((r) => seq === loadSeq.current && setRows(r.drafts))
      .catch((e) => seq === loadSeq.current && setLoadError(e instanceof Error ? e.message : String(e)))
      .finally(() => seq === loadSeq.current && setLoading(false));
  }, [status]);
  useEffect(load, [load]);

  /** ACC one after another; one that no longer fits says why and the rest go on. */
  const approve = async (ids: number[]) => {
    setBusy(true);
    let ok = 0;
    for (const id of ids) {
      try {
        await api.post(`/catalog/drafts/${id}/review`, { approve: true });
        ok++;
      } catch (e) {
        const r = rows.find((x) => x.id === id);
        toast(`${r?.code ?? ""} ${r?.uom ?? ""}: ${e instanceof Error ? e.message : "Gagal di-ACC."}`, "error");
      }
    }
    setBusy(false);
    if (ok) toast(`${ok} draf di-ACC dan sudah masuk katalog.`, "success");
    load();
    changed();
  };
  const reject = async () => {
    if (!rejecting) return;
    setBusy(true);
    try {
      await api.post(`/catalog/drafts/${rejecting.id}/review`, { approve: false, note });
      toast("Draf ditolak.", "success");
      setRejecting(null);
      setNote("");
      load();
      changed();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Gagal.", "error");
    } finally {
      setBusy(false);
    }
  };
  const cancel = async (id: number) => {
    try {
      await api.post(`/catalog/drafts/${id}/cancel`, {});
      toast("Draf dibatalkan.", "success");
      load();
      changed();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Gagal.", "error");
    }
  };
  const toggle = (id: number) =>
    setPicked((s) => {
      const n = new Set(s);
      if (!n.delete(id)) n.add(id);
      return n;
    });

  return (
    <main className="hk-main page-stack">
      <div className="hk-page-head">
        <div>
          <h1>Draf Perbaikan Divisi Gudang</h1>
          <p>
            {reviewer
              ? "Perubahan Admin Gudang di Katalog (barcode, satuan, data barang). Baru masuk katalog setelah di-ACC. Stok tetap dari Accurate."
              : "Perubahan Anda di Katalog menunggu ACC admin di sini. Yang ditolak tampil di tab Riwayat beserta alasannya."}
          </p>
        </div>
        <div className="row-wrap">
          {reviewer && status === "pending" && picked.size > 0 && (
            <button className="btn primary" disabled={busy} onClick={() => void approve([...picked])}>
              ACC {grp(picked.size)} yang dipilih
            </button>
          )}
          <button className="btn ghost" onClick={load} disabled={loading}>Muat ulang</button>
        </div>
      </div>

      <div className="card">
        <div className="tabs card-tabs" role="group" aria-label="Status draf">
          {([
            ["pending", "Menunggu ACC"],
            ["done", "Riwayat"],
          ] as const).map(([key, label]) => (
            <button key={key} className={status === key ? "on" : ""} aria-pressed={status === key} onClick={() => setStatus(key)}>
              {label}
              {key === "pending" && waiting != null && <span className="tab-count num">{grp(waiting)}</span>}
            </button>
          ))}
        </div>

        {loadError ? (
          <LoadError message={loadError} onRetry={load} />
        ) : loading ? (
          <div className="card-body skeleton-list" role="status" aria-label="Memuat draf…">
            {[0, 1, 2].map((i) => <span key={i} className="skeleton" />)}
          </div>
        ) : rows.length === 0 ? (
          <div className="card-body empty">
            <h3>{status === "pending" ? "Tidak ada draf yang menunggu" : "Belum ada riwayat"}</h3>
            <p>
              {status === "pending"
                ? "Draf muncul di sini saat Admin Gudang menyimpan barcode, satuan, atau data barang di Katalog."
                : "Draf yang sudah di-ACC, ditolak, atau dibatalkan muncul di sini."}
            </p>
          </div>
        ) : (
          <ul className="fix-list">
            {rows.map((r) => (
              <li key={r.id} className="fix-row">
                <div className="fix-main">
                  <div className="badge-row">
                    {reviewer && status === "pending" && (
                      <input type="checkbox" checked={picked.has(r.id)} onChange={() => toggle(r.id)} aria-label={`Pilih draf ${r.code} ${r.uom}`} />
                    )}
                    <span className="badge amber">{KIND_LABEL[r.kind]}</span>
                    {r.status !== "pending" && <span className={`badge ${STATUS[r.status][0]}`}>{STATUS[r.status][1]}</span>}
                  </div>
                  <strong className="fix-item">
                    {r.name ?? "(barang tidak ada lagi)"} <span className="muted num">· {r.code}</span>
                  </strong>
                  {draftChanges(r.kind, r.uom, r.payload, r.before).map((line) => (
                    <div key={line} className="num">{line}</div>
                  ))}
                  <div className="muted small">
                    {r.created_by_name}, {fmtDateTime(r.created_at)}
                    {r.reviewed_at && r.status !== "cancelled" && (
                      <> · {STATUS[r.status as "approved"][1]} oleh {r.reviewed_by_name}, {fmtDateTime(r.reviewed_at)}</>
                    )}
                  </div>
                  {r.note && <div className="fix-done"><em>{r.note}</em></div>}
                </div>
                {status === "pending" && (
                  <div className="fix-actions">
                    {reviewer ? (
                      <>
                        <button className="btn small primary" disabled={busy} onClick={() => void approve([r.id])}>ACC</button>
                        <button className="btn small ghost danger" disabled={busy} onClick={() => setRejecting(r)}>Tolak</button>
                      </>
                    ) : (
                      <button className="btn small ghost" onClick={() => void cancel(r.id)}>Batalkan</button>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {rejecting && (
        <Modal
          title="Tolak draf"
          sub={`${rejecting.code} · ${KIND_LABEL[rejecting.kind]}${rejecting.uom ? ` ${rejecting.uom}` : ""}`}
          onClose={() => setRejecting(null)}
          footer={
            <>
              <button className="btn ghost" onClick={() => setRejecting(null)}>Batal</button>
              <button className="btn primary" onClick={() => void reject()} disabled={busy || !note.trim()}>
                {busy ? "Menyimpan…" : "Tolak"}
              </button>
            </>
          }
        >
          <label className="field">
            <span>Alasan (dibaca Admin Gudang)</span>
            <textarea
              className="textarea"
              rows={3}
              autoFocus
              placeholder="mis. Barcode ini milik kemasan Box, bukan Pcs"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
        </Modal>
      )}
    </main>
  );
}
