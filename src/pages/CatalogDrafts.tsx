/* Menu Gudang (2026-11-19; was "Draf Perbaikan Divisi Gudang"): what an Admin Gudang changed in Katalog (barcode, Buat barcode,
   Tambah satuan, Ubah barang) and every uploaded catalog file (2026-11-20, grouped per file), waiting for an admin. ACC applies it to the catalog; Tolak needs a reason.
   The Admin Gudang sees their own drafts here and can take one back. Server: /catalog/drafts. */

import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { LoadError } from "../components/LoadError";
import { StockActions, StockHistoryList, type StockHistoryRow } from "../components/StockPanel";
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

/** One uploaded spreadsheet; its rows are `import` drafts, listed per file because a file can hold thousands. */
interface ImportFile {
  id: number;
  source: string;
  mode: "merge" | "replace";
  created_by_name: string | null;
  created_at: string;
  total: number;
  pending: number;
  approved: number;
  rejected: number;
}
interface OpenFile {
  drafts: DraftRow[];
  total: number;
  loading: boolean;
}
const PAGE = 100;
const MODE_LABEL: Record<ImportFile["mode"], string> = { merge: "Gabung ke katalog", replace: "Ganti seluruh katalog" };

const KIND_LABEL: Record<DraftRow["kind"], string> = { barcode: "Barcode", unit: "Satuan baru", edit: "Ubah barang", stock: "Stok", import: "Impor file" };
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
  const [status, setStatus] = useState<"pending" | "done" | "stock">("pending");
  const [history, setHistory] = useState<StockHistoryRow[]>([]);
  const [rows, setRows] = useState<DraftRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [files, setFiles] = useState<ImportFile[]>([]);
  const [open, setOpen] = useState<Map<number, OpenFile>>(new Map());
  const [rejecting, setRejecting] = useState<DraftRow | null>(null);
  const [rejectingFile, setRejectingFile] = useState<ImportFile | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const loadSeq = useRef(0);
  const load = useCallback(() => {
    const seq = ++loadSeq.current;
    setLoading(true);
    setLoadError(null);
    setPicked(new Set());
    setOpen(new Map());
    // Riwayat stok tab: the stock history of every item, not drafts.
    (status === "stock"
      ? api.get<{ history: StockHistoryRow[] }>("/stock/history").then((r) => seq === loadSeq.current && (setHistory(r.history), setRows([]), setFiles([])))
      : Promise.all([
          api.get<{ drafts: DraftRow[] }>(`/catalog/drafts?status=${status}`),
          api.get<{ imports: ImportFile[] }>(`/catalog/imports?status=${status}`),
        ]).then(([d, f]) => seq === loadSeq.current && (setRows(d.drafts), setFiles(f.imports)))
    )
      .catch((e) => seq === loadSeq.current && setLoadError(e instanceof Error ? e.message : String(e)))
      .finally(() => seq === loadSeq.current && setLoading(false));
  }, [status]);
  useEffect(load, [load]);

  /** Open the draft rows of one file (a page at a time). */
  const openFile = async (f: ImportFile, more = false) => {
    const have = more ? open.get(f.id)?.drafts ?? [] : [];
    setOpen((m) => new Map(m).set(f.id, { drafts: have, total: f.pending, loading: true }));
    try {
      const r = await api.get<{ drafts: DraftRow[]; total: number }>(`/catalog/imports/${f.id}/drafts?limit=${PAGE}&offset=${have.length}`);
      const drafts = r.drafts.map((d) => ({ ...d, name: String(d.payload.name ?? d.before.name ?? ""), created_by_name: f.created_by_name, created_at: f.created_at, reviewed_by_name: null, reviewed_at: null, note: "" }));
      setOpen((m) => new Map(m).set(f.id, { drafts: [...have, ...drafts], total: r.total, loading: false }));
    } catch (e) {
      setOpen((m) => { const n = new Map(m); n.delete(f.id); return n; });
      toast(e instanceof Error ? e.message : "Gagal memuat isi file.", "error");
    }
  };
  const closeFile = (id: number) => setOpen((m) => { const n = new Map(m); n.delete(id); return n; });

  /** ACC / Tolak a whole file, or the ticked rows of it, in one request. */
  const reviewFile = async (f: ImportFile, approve: boolean, ids?: number[], why = "") => {
    setBusy(true);
    try {
      const r = await api.post<{ count: number }>(`/catalog/imports/${f.id}/review`, { approve, note: why, ...(ids && { ids }) });
      toast(approve ? `${grp(r.count)} barang dari ${f.source} di-ACC dan sudah masuk katalog.` : `${grp(r.count)} barang dari ${f.source} ditolak.`, "success");
      return true;
    } catch (e) {
      toast(`${f.source}: ${e instanceof Error ? e.message : "Gagal."}`, "error");
      return false;
    } finally {
      setBusy(false);
      load();
      changed();
    }
  };
  const rejectFile = async () => {
    if (!rejectingFile) return;
    if (await reviewFile(rejectingFile, false, undefined, note)) {
      setRejectingFile(null);
      setNote("");
    }
  };

  /** ACC one after another; one that no longer fits says why and the rest go on. Rows of an import file go together, per file. */
  const approve = async (ids: number[]) => {
    const fileOf = new Map<number, number>();
    for (const [fid, o] of open) for (const d of o.drafts) fileOf.set(d.id, fid);
    const perFile = new Map<number, number[]>();
    for (const id of ids) if (fileOf.has(id)) perFile.set(fileOf.get(id)!, [...(perFile.get(fileOf.get(id)!) ?? []), id]);
    for (const [fid, fileIds] of perFile) await reviewFile(files.find((f) => f.id === fid)!, true, fileIds);
    ids = ids.filter((id) => !fileOf.has(id));
    if (!ids.length) return;
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
  /** Pick or unpick every change of one item at once. */
  const toggle = (ids: number[]) =>
    setPicked((s) => {
      const n = new Set(s);
      const all = ids.every((id) => n.has(id));
      for (const id of ids) all ? n.delete(id) : n.add(id);
      return n;
    });
  // One card per item: barcode, satuan and Ubah barang of the same barang sit together.
  /** Every row on screen: the item cards and the opened import files. */
  const shownIds = [...rows.map((r) => r.id), ...[...open.values()].flatMap((o) => o.drafts.map((d) => d.id))];
  const allPicked = shownIds.length > 0 && shownIds.every((id) => picked.has(id));
  const cards = [...rows.reduce((m, r) => m.set(r.code, [...(m.get(r.code) ?? []), r]), new Map<string, DraftRow[]>()).values()];

  return (
    <main className="hk-main page-stack">
      <div className="hk-page-head">
        <div>
          <h1>Gudang</h1>
          <p>
            {reviewer
              ? "Perubahan Admin Gudang di Katalog (barcode, satuan, data barang) dan file impor katalog. Baru masuk katalog setelah di-ACC. Stok katalog hanya berubah lewat Tarik, draf stok, atau file impor yang di-ACC."
              : "Barcode dan satuan tetap dikerjakan di Katalog. Hasilnya menunggu ACC admin di sini; yang ditolak tampil di tab Riwayat beserta alasannya."}
          </p>
        </div>
        <div className="row-wrap">
          {reviewer && status === "pending" && shownIds.length > 0 && (
            <label className="row-wrap">
              <input
                type="checkbox"
                checked={allPicked}
                onChange={() => setPicked(allPicked ? new Set() : new Set(shownIds))}
                aria-label="Pilih semua yang tampil"
              />
              <span>Pilih semua</span>
            </label>
          )}
          {reviewer && status === "pending" && picked.size > 0 && (
            <button className="btn primary" disabled={busy} onClick={() => void approve([...picked])}>
              ACC {grp(picked.size)} yang dipilih
            </button>
          )}
          <StockActions onPulled={load} />
          <Link className="btn ghost" to="/catalog">Barcode &amp; satuan (Katalog)</Link>
          <button className="btn ghost" onClick={load} disabled={loading}>Muat ulang</button>
        </div>
      </div>

      <div className="card">
        <div className="tabs card-tabs" role="group" aria-label="Sub-menu Gudang">
          {([
            ["pending", reviewer ? "Menunggu ACC" : "Draf saya"],
            ["done", "Riwayat"],
            ["stock", "Riwayat stok"],
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
        ) : status === "stock" ? (
          <div className="card-body"><StockHistoryList rows={history} withItem /></div>
        ) : rows.length === 0 && files.length === 0 ? (
          <div className="card-body empty">
            <h3>{status === "pending" ? "Tidak ada draf yang menunggu" : "Belum ada riwayat"}</h3>
            <p>
              {status === "pending"
                ? "Draf muncul di sini saat barcode, satuan, data barang, atau stok disimpan di Katalog."
                : "Draf yang sudah di-ACC, ditolak, atau dibatalkan muncul di sini."}
            </p>
          </div>
        ) : (
          <ul className="fix-list">
            {files.map((f) => {
              const o = open.get(f.id);
              const pending = reviewer && status === "pending";
              return (
                <li key={`file-${f.id}`} className="fix-row draft-card">
                  <div className="draft-head">
                    <strong className="fix-item">
                      <span>
                        {f.source} <span className="badge amber">{MODE_LABEL[f.mode]}</span>
                      </span>
                    </strong>
                    <div className="row-wrap">
                      {status === "pending" && (
                        <button className="btn small ghost" onClick={() => (o ? closeFile(f.id) : void openFile(f))}>
                          {o ? "Tutup isi" : "Lihat isi"}
                        </button>
                      )}
                      {pending && (
                        <>
                          <button className="btn small primary" disabled={busy} onClick={() => void reviewFile(f, true)}>ACC seluruh file</button>
                          <button className="btn small ghost danger" disabled={busy} onClick={() => setRejectingFile(f)}>Tolak seluruh file</button>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="muted small">
                    Diunggah {f.created_by_name}, {fmtDateTime(f.created_at)} ·{" "}
                    {status === "pending"
                      ? `${grp(f.pending)} barang menunggu${f.total > f.pending ? ` (dari ${grp(f.total)})` : ""}`
                      : `${grp(f.approved)} di-ACC, ${grp(f.rejected)} ditolak`}
                  </div>
                  {o && (
                    <>
                      <ul className="draft-changes">
                        {o.drafts.map((r) => (
                          <li key={r.id} className="draft-change">
                            <div className="fix-main">
                              <strong className="fix-item">
                                {pending && (
                                  <input type="checkbox" checked={picked.has(r.id)} onChange={() => toggle([r.id])} aria-label={`Pilih ${r.code}`} />
                                )}
                                <span>{r.name || r.code} <span className="muted num">· {r.code}</span></span>
                              </strong>
                              {draftChanges(r.kind, r.uom, r.payload, r.before).map((line) => (
                                <div key={line} className="num">{line}</div>
                              ))}
                            </div>
                            {pending && (
                              <div className="fix-actions">
                                <button className="btn small primary" disabled={busy} onClick={() => void approve([r.id])}>ACC</button>
                                <button className="btn small ghost danger" disabled={busy} onClick={() => setRejecting(r)}>Tolak</button>
                              </div>
                            )}
                          </li>
                        ))}
                      </ul>
                      {o.loading && <div className="muted small" role="status">Memuat…</div>}
                      {!o.loading && o.drafts.length < o.total && (
                        <button className="btn small ghost" onClick={() => void openFile(f, true)}>
                          Muat lebih banyak ({grp(o.drafts.length)} dari {grp(o.total)})
                        </button>
                      )}
                    </>
                  )}
                </li>
              );
            })}
            {cards.map((group) => {
              const ids = group.map((r) => r.id);
              const pending = reviewer && status === "pending";
              return (
                <li key={group[0].code} className="fix-row draft-card">
                  <div className="draft-head">
                    <strong className="fix-item">
                      {pending && (
                        <input
                          type="checkbox"
                          checked={ids.every((id) => picked.has(id))}
                          onChange={() => toggle(ids)}
                          aria-label={`Pilih semua draf ${group[0].code}`}
                        />
                      )}
                      <span>
                        {group[0].name ?? "(barang tidak ada lagi)"} <span className="muted num">· {group[0].code}</span>
                      </span>
                    </strong>
                    {pending && group.length > 1 && (
                      <button className="btn small primary" disabled={busy} onClick={() => void approve(ids)}>
                        ACC semua ({grp(group.length)})
                      </button>
                    )}
                  </div>
                  <ul className="draft-changes">
                    {group.map((r) => (
                      <li key={r.id} className="draft-change">
                        <div className="fix-main">
                          <div className="badge-row">
                            <span className="badge amber">{KIND_LABEL[r.kind]}</span>
                            {r.status !== "pending" && <span className={`badge ${STATUS[r.status][0]}`}>{STATUS[r.status][1]}</span>}
                          </div>
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
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {rejectingFile && (
        <Modal
          title="Tolak seluruh file"
          sub={`${rejectingFile.source} · ${grp(rejectingFile.pending)} barang`}
          onClose={() => setRejectingFile(null)}
          footer={
            <>
              <button className="btn ghost" onClick={() => setRejectingFile(null)}>Batal</button>
              <button className="btn primary" onClick={() => void rejectFile()} disabled={busy || !note.trim()}>
                {busy ? "Menyimpan…" : "Tolak seluruh file"}
              </button>
            </>
          }
        >
          <label className="field">
            <span>Alasan (dibaca yang mengunggah)</span>
            <textarea className="textarea" rows={3} autoFocus placeholder="mis. Kolom harga jual tertukar dengan COGS" value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
        </Modal>
      )}

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
