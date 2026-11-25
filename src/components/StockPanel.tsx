/* Stok di Pricing Engine (2026-11-20): tombol Tarik / Cocokkan / Kirim, isian stok yang menjadi draf
   (menunggu ACC admin), dan riwayat stok. Server: /api/stock/*, PUT /api/catalog/:id/stock. */

import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { useAuth } from "../context/AuthContext";
import { useToast } from "../context/ToastContext";
import { Modal } from "./Modal";
import { grp } from "@shared/format";
import type { CatalogItem } from "@shared/types";
import type { SkuPatch } from "./SkuBarcodes";

export const TARIK_HINT = "Ambil data stok terbaru dari Accurate ke Pricing Engine";
export const COCOK_HINT = "Bandingkan angka stok di Pricing Engine dengan Accurate";
export const KIRIM_HINT = "Kirim perubahan stok yang sudah di-ACC ke Accurate";
export const KIRIM_OFF = "Belum aktif: menunggu izin token Accurate dan data akuntansi";

/** Waktu dari server (UTC) ditampilkan dalam WIB. */
export const wib = (s: string) =>
  `${new Date(`${s.replace(" ", "T")}Z`).toLocaleString("id-ID", {
    timeZone: "Asia/Jakarta", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
  })} WIB`;

interface PullResult { done: boolean; changed?: number; skipped?: number; confirmed?: number; phase?: string; itemsSeen?: number; stockRows?: number; busy?: boolean }
interface CompareRow { code: string; name: string; uom: string; pe: number; accurate: number; diff: number; unsent: boolean }

/** The three buttons. Tarik and Cocokkan: manager/admin and Admin Gudang. Kirim shows but stays off. */
export function StockActions({ onPulled }: { onPulled?: () => void }) {
  const { can } = useAuth();
  const toast = useToast();
  const allowed = can("import_catalog") || can("draft_catalog");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [rows, setRows] = useState<CompareRow[] | null>(null);
  const [more, setMore] = useState(false);
  const [unsent, setUnsent] = useState(0);

  const loadStatus = useCallback(() => {
    if (allowed) api.get<{ unsent: number }>("/stock/status").then((r) => setUnsent(r.unsent)).catch(() => {});
  }, [allowed]);
  useEffect(loadStatus, [loadStatus]);
  useEffect(() => {
    window.addEventListener("catalog-drafts-changed", loadStatus);
    return () => window.removeEventListener("catalog-drafts-changed", loadStatus);
  }, [loadStatus]);
  if (!allowed) return null;

  // The sync may take several calls; keep going until it has finished and the stock is copied.
  const pull = async () => {
    setBusy(true);
    let restart = true;
    try {
      for (let i = 0; i < 60; i++) {
        const r = await api.post<PullResult>("/stock/pull", { restart });
        restart = false;
        if (r.done) {
          toast(
            `Stok ditarik: ${grp(r.changed ?? 0)} barang berubah${r.skipped ? `, ${grp(r.skipped)} dilewati karena perubahan ACC-nya belum terkirim ke Accurate` : ""}${r.confirmed ? `, ${grp(r.confirmed)} koreksi ACC sudah tercatat di Accurate` : ""}.`,
            "success",
          );
          onPulled?.();
          loadStatus();
          return;
        }
        setProgress(`${grp(r.itemsSeen ?? 0)} barang, ${grp(r.stockRows ?? 0)} stok dibaca`);
        if (r.busy) await new Promise((ok) => setTimeout(ok, 3000));
      }
      toast("Sinkron Accurate masih berjalan. Tekan Tarik lagi untuk melanjutkan.");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Gagal menarik stok.", "error");
    } finally {
      setBusy(false);
      setProgress("");
    }
  };

  const compare = async () => {
    setBusy(true);
    try {
      const r = await api.get<{ items: CompareRow[]; more: boolean }>("/stock/compare");
      setRows(r.items);
      setMore(r.more);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Gagal membandingkan stok.", "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="row-wrap" role="group" aria-label="Stok Accurate">
        <button className="btn small" disabled={busy} title={TARIK_HINT} aria-label={TARIK_HINT} onClick={() => void pull()}>
          {busy && progress ? `Menarik… ${progress}` : "Tarik"}
        </button>
        <button className="btn small ghost" disabled={busy} title={COCOK_HINT} aria-label={COCOK_HINT} onClick={() => void compare()}>
          Cocokkan
        </button>
        {/* A disabled button shows no tooltip in some browsers, so the wrapper carries it too. */}
        <span title={KIRIM_OFF}>
          <button className="btn small ghost" disabled title={KIRIM_OFF} aria-label={`${KIRIM_HINT}. ${KIRIM_OFF}`}>
            Kirim{unsent > 0 ? ` (${grp(unsent)} menunggu)` : ""}
          </button>
        </span>
      </div>
      {rows && (
        <Modal
          title="Cocokkan stok"
          sub={rows.length ? `${grp(rows.length)}${more ? "+" : ""} barang selisih` : undefined}
          size="wide"
          onClose={() => setRows(null)}
          footer={<button className="btn" onClick={() => setRows(null)}>Tutup</button>}
        >
          {rows.length === 0 ? (
            <p>Semua angka stok sama dengan Accurate (barang dengan satuan yang berbeda tidak dibandingkan).</p>
          ) : (
            <div className="table-wrap flush">
              <table className="table">
                <thead>
                  <tr>
                    <th className="l">Barang</th>
                    <th className="l">Satuan</th>
                    <th>Pricing Engine</th>
                    <th>Accurate</th>
                    <th>Selisih</th>
                    <th className="l" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.code}>
                      <td className="l">{r.name} <span className="muted num">· {r.code}</span></td>
                      <td className="l">{r.uom}</td>
                      <td className="num">{grp(r.pe)}</td>
                      <td className="num">{grp(r.accurate)}</td>
                      <td className="num">{r.diff > 0 ? "+" : ""}{grp(r.diff)}</td>
                      <td className="l">{r.unsent && <span className="badge amber" title="Sudah di-ACC, belum dikirim ke Accurate">belum terkirim</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Modal>
      )}
    </>
  );
}

export interface StockHistoryRow {
  id: number; code: string; name: string | null; uom: string; before: number; after: number; source: string;
  note: string; created_at: string; filled_by_name: string | null; approved_by_name: string | null;
}

const SOURCE: Record<string, string> = {
  draft_approved: "Draf di-ACC", draft_rejected: "Draf ditolak", tarik: "Tarik dari Accurate", apply: "Terapkan ke katalog", kirim: "Tercatat di Accurate", import: "Impor",
};

/** One line per stock change: time (WIB), before to after, who filled, who ACCed or refused, source. */
export function StockHistoryList({ rows, withItem }: { rows: StockHistoryRow[]; withItem?: boolean }) {
  if (!rows.length) return <p className="muted small">Belum ada riwayat stok.</p>;
  return (
    <ul className="draft-changes">
      {rows.map((h) => (
        <li key={h.id} className="draft-change">
          <div className="fix-main">
            <div className="num">
              {withItem && <>{h.name ?? h.code} <span className="muted">· {h.code}</span> · </>}
              {grp(h.before)} → {grp(h.after)} {h.uom}
              {h.source === "draft_rejected" && <span className="muted"> (usulan, stok tetap)</span>}
            </div>
            <div className="muted small">
              {wib(h.created_at)} · {SOURCE[h.source] ?? h.source}
              {h.filled_by_name && <> · {h.source === "kirim" ? "ditandai" : "diisi"} {h.filled_by_name}</>}
              {h.approved_by_name && <> · {h.source === "draft_rejected" ? "ditolak" : "di-ACC"} {h.approved_by_name}</>}
            </div>
            {h.note && <div className="fix-done"><em>{h.note}</em></div>}
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Katalog › opened item: the stock figure (becomes a draft for an admin's ACC) and this item's history. */
export function StockEntry({ item, onChange }: { item: CatalogItem; onChange: (patch: SkuPatch) => void }) {
  const { can } = useAuth();
  const toast = useToast();
  const mayEnter = can("draft_catalog") || can("edit_catalog");
  const seeHistory = can("import_catalog") || can("draft_catalog");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<StockHistoryRow[]>([]);
  const draft = (item.drafts ?? []).find((d) => d.kind === "stock");
  const n = Number(value.replace(",", "."));

  const loadHistory = useCallback(() => {
    if (seeHistory) api.get<{ history: StockHistoryRow[] }>(`/stock/history?code=${encodeURIComponent(item.code)}`).then((r) => setHistory(r.history)).catch(() => {});
  }, [item.code, seeHistory]);
  useEffect(loadHistory, [loadHistory, item.stock]);
  if (!mayEnter && !seeHistory) return null;

  const submit = async () => {
    if (busy || !value.trim() || !Number.isFinite(n)) return;
    setBusy(true);
    setError(null);
    try {
      onChange(await api.put<SkuPatch>(`/catalog/${item.id}/stock`, { stock: n }));
      setValue("");
      toast("Stok masuk draf, menunggu ACC admin.", "success");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Gagal menyimpan stok.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sku-row">
      <div className="sku-head">
        <strong>Stok</strong>
        <span className="muted small">satuan dasar {item.uom}</span>
        <span className="num">{grp(item.stock)}</span>
        {draft && <span className="badge amber">usulan {grp(Number(draft.payload.stock))} menunggu ACC</span>}
      </div>
      {mayEnter && (
        <div className="barcode-line">
          <input
            className={`input num${error ? " invalid" : ""}`}
            inputMode="decimal"
            placeholder="Stok yang benar"
            aria-label={`Stok ${item.name} (${item.uom})`}
            value={value}
            readOnly={busy}
            onChange={(e) => { setValue(e.target.value); setError(null); }}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void submit(); } }}
          />
          <button
            className="btn small"
            disabled={busy || !value.trim() || !Number.isFinite(n)}
            title="Ajukan koreksi stok. Baru berlaku setelah di-ACC admin."
            onClick={() => void submit()}
          >
            {busy ? "Menyimpan…" : "Ajukan stok"}
          </button>
        </div>
      )}
      {error && <div className="text-err small" role="alert">{error}</div>}
      {seeHistory && history.length > 0 && (
        <details>
          <summary className="muted small">Riwayat stok ({history.length})</summary>
          <StockHistoryList rows={history} />
        </details>
      )}
    </div>
  );
}

interface UnsentRow {
  code: string; name: string | null; uom: string; stock: number; accurate: number | null; diff: number | null;
  before: number | null; since: string; approved_at: string | null; filled_by_name: string | null; approved_by_name: string | null;
}

/** Gudang › Input ke Accurate (admin; Bu Hesti): stok yang sudah di-ACC dan perlu diinput manual ke Accurate selama Kirim mati.
 *  Barang keluar sendiri saat angka Accurate sudah sama (sinkron atau Tarik), atau lewat "Sudah diinput di Accurate". */
export function UnsentStockList({ onChanged }: { onChanged?: () => void }) {
  const toast = useToast();
  const [rows, setRows] = useState<UnsentRow[] | null>(null);
  const [asOf, setAsOf] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setError(null);
    api
      .get<{ items: UnsentRow[]; asOf: string | null }>("/stock/unsent")
      .then((r) => (setRows(r.items), setAsOf(r.asOf), setPicked(new Set())))
      .catch((e) => setError(e instanceof Error ? e.message : "Gagal memuat daftar."));
  }, []);
  useEffect(load, [load]);

  const markDone = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ done: number }>("/stock/unsent/done", { codes: [...picked], note });
      toast(`${grp(r.done)} barang ditandai sudah diinput di Accurate.`, "success");
      setConfirming(false);
      setNote("");
      load();
      window.dispatchEvent(new Event("catalog-drafts-changed"));
      onChanged?.();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Gagal menandai.", "error");
    } finally {
      setBusy(false);
    }
  };

  if (error) return <div className="card-body"><p className="text-err" role="alert">{error}</p></div>;
  if (!rows) return <div className="card-body skeleton-list" role="status" aria-label="Memuat…"><span className="skeleton" /></div>;
  if (!rows.length)
    return (
      <div className="card-body empty">
        <h3>Tidak ada yang perlu diinput</h3>
        <p className="muted">Semua stok yang sudah di-ACC sudah tercatat di Accurate.</p>
      </div>
    );
  const all = rows.every((r) => picked.has(r.code));
  return (
    <div className="card-body">
      <p className="muted small">
        Stok di bawah sudah di-ACC tetapi belum tercatat di Accurate. Input selisihnya sebagai penyesuaian persediaan di Accurate.
        Barang keluar sendiri dari daftar setelah sinkron berikutnya bila angka Accurate sudah sama
        {asOf ? ` (sinkron terakhir ${wib(asOf.replace("T", " ").replace(/\..*$/, ""))})` : ""}, atau tekan Tarik.
        Bila sudah diinput tetapi angkanya tidak bisa sama karena ada transaksi lain, tandai "Sudah diinput".
      </p>
      <div className="row-wrap">
        <label className="row-wrap">
          <input type="checkbox" checked={all} onChange={() => setPicked(all ? new Set() : new Set(rows.map((r) => r.code)))} aria-label="Pilih semua" />
          <span>Pilih semua</span>
        </label>
        <button className="btn primary small" disabled={!picked.size} onClick={() => setConfirming(true)}>
          Sudah diinput di Accurate{picked.size ? ` (${grp(picked.size)})` : ""}
        </button>
      </div>
      <div className="table-wrap flush">
        <table className="table stack">
          <thead>
            <tr>
              <th className="col-icon" />
              <th className="l">Barang</th>
              <th className="l">Satuan</th>
              <th>Hasil ACC</th>
              <th>Accurate sekarang</th>
              <th>Perlu diinput</th>
              <th className="l">Diajukan / di-ACC</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.code}>
                <td className="col-icon">
                  <input
                    type="checkbox"
                    checked={picked.has(r.code)}
                    onChange={() => setPicked((s) => { const n = new Set(s); n.has(r.code) ? n.delete(r.code) : n.add(r.code); return n; })}
                    aria-label={`Pilih ${r.name ?? r.code}`}
                  />
                </td>
                <td className="l">{r.name ?? "(barang sudah tidak ada di katalog)"} <span className="muted num">· {r.code}</span></td>
                <td className="l">{r.uom}</td>
                <td className="num">{grp(r.stock)}</td>
                <td className="num">{r.accurate == null ? "–" : grp(r.accurate)}</td>
                <td className="num">
                  {r.diff == null ? (
                    <span className="muted small" title="Barang tidak ada di Accurate atau satuannya berbeda">cek manual</span>
                  ) : (
                    <strong>{r.diff > 0 ? "+" : ""}{grp(r.diff)}</strong>
                  )}
                </td>
                <td className="l small">
                  {r.filled_by_name ?? "–"} / {r.approved_by_name ?? "–"}
                  <div className="muted">{wib(r.approved_at ?? r.since)}</div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {confirming && (
        <Modal
          title="Sudah diinput di Accurate?"
          sub={`${grp(picked.size)} barang`}
          onClose={() => setConfirming(false)}
          footer={
            <>
              <button className="btn ghost" onClick={() => setConfirming(false)}>Batal</button>
              <button className="btn primary" disabled={busy} onClick={() => void markDone()}>{busy ? "Menyimpan…" : "Ya, sudah diinput"}</button>
            </>
          }
        >
          <p>Barang keluar dari daftar ini, dan Tarik kembali memakai angka Accurate untuk barang itu. Nama Anda tercatat di Riwayat stok.</p>
          <label className="field">
            <span>Catatan (opsional)</span>
            <input className="input" value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} placeholder="mis. nomor penyesuaian di Accurate" />
          </label>
        </Modal>
      )}
    </div>
  );
}
