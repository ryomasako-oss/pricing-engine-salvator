/* Stok (2026-11-25): stok di Pricing Engine ikut Accurate (tombol Sinkron Accurate + otomatis tiap sinkron). Cycle count
   gudang per gudang menjadi draf; yang di-ACC jadi stok pembanding, dan selisihnya menunggu "Belum masuk Accurate".
   Server: /api/stock/*, PUT /api/catalog/:id/stock. */

import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { useAuth } from "../context/AuthContext";
import { useToast } from "../context/ToastContext";
import { Modal } from "./Modal";
import { grp } from "@shared/format";
import type { CatalogItem } from "@shared/types";
import type { SkuPatch } from "./SkuBarcodes";

export const SINKRON_HINT = "Ambil stok terbaru dari Accurate ke Pricing Engine (otomatis juga tiap 6 jam)";

/** Waktu dari server (UTC) ditampilkan dalam WIB. */
export const wib = (s: string) =>
  `${new Date(`${s.replace(" ", "T")}Z`).toLocaleString("id-ID", {
    timeZone: "Asia/Jakarta", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
  })} WIB`;

interface PullResult { done: boolean; changed?: number; skipped?: number; entered?: number; phase?: string; itemsSeen?: number; stockRows?: number; busy?: boolean }
interface CompareRow { code: string; name: string; uom: string; pe: number; accurate: number; diff: number }

/** Satu tombol Accurate (2026-11-25): Sinkron = ambil stok terbaru dari Accurate ke Pricing Engine, lalu ringkasan
 *  dengan "Lihat selisih" (dulu Cocokkan). Kirim disembunyikan sampai pengiriman otomatis ke Accurate aktif. */
export function StockActions({ onPulled }: { onPulled?: () => void }) {
  const { can } = useAuth();
  const toast = useToast();
  const allowed = can("import_catalog") || can("draft_catalog");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [summary, setSummary] = useState<PullResult | null>(null);
  const [rows, setRows] = useState<CompareRow[] | null>(null);
  const [more, setMore] = useState(false);
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
          setSummary(r);
          setRows(null);
          onPulled?.();
          window.dispatchEvent(new Event("catalog-drafts-changed"));
          return;
        }
        setProgress(`${grp(r.itemsSeen ?? 0)} barang, ${grp(r.stockRows ?? 0)} stok dibaca`);
        if (r.busy) await new Promise((ok) => setTimeout(ok, 3000));
      }
      toast("Sinkron Accurate masih berjalan. Tekan lagi untuk melanjutkan.");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Gagal sinkron Accurate.", "error");
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
      <button className="btn small" disabled={busy} title={SINKRON_HINT} aria-label={SINKRON_HINT} onClick={() => void pull()}>
        {busy && progress ? `Sinkron… ${progress}` : busy ? "Sinkron…" : "Sinkron Accurate"}
      </button>
      {summary && (
        <Modal
          title={rows ? "Selisih stok dengan Accurate" : "Sinkron Accurate selesai"}
          sub={rows ? (rows.length ? `${grp(rows.length)}${more ? "+" : ""} barang selisih` : undefined) : undefined}
          size={rows ? "wide" : undefined}
          onClose={() => (setSummary(null), setRows(null))}
          footer={
            <>
              {!rows && <button className="btn ghost" disabled={busy} onClick={() => void compare()}>Lihat selisih</button>}
              <button className="btn" onClick={() => (setSummary(null), setRows(null))}>Tutup</button>
            </>
          }
        >
          {!rows ? (
            <ul className="plain">
              <li>{grp(summary.changed ?? 0)} barang stoknya diperbarui dari Accurate.</li>
              {!!summary.entered && <li>{grp(summary.entered)} hitungan gudang sudah tercatat masuk Accurate.</li>}
            </ul>
          ) : rows.length === 0 ? (
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
  draft_approved: "Draf di-ACC", draft_rejected: "Draf ditolak", tarik: "Tarik dari Accurate", apply: "Terapkan ke katalog", kirim: "Dikirim ke Accurate", import: "Impor",
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
              {h.filled_by_name && <> · diisi {h.filled_by_name}</>}
              {h.approved_by_name && <> · {h.source === "draft_rejected" ? "ditolak" : "di-ACC"} {h.approved_by_name}</>}
            </div>
            {h.note && <div className="fix-done"><em>{h.note}</em></div>}
          </div>
        </li>
      ))}
    </ul>
  );
}

export interface StockCountRow {
  id: number; code: string; name: string | null; uom: string; warehouse: string; counted: number; accurate_qty: number | null;
  accurate_source: string | null; diff: number | null; counted_at: string; approved_at: string; status: "open" | "entered" | "matched";
  entered_at: string | null; entered_how: string | null; entered_ref: string; note: string;
  counted_by_name: string | null; approved_by_name: string | null; entered_by_name: string | null;
}

const signed = (n: number) => `${n > 0 ? "+" : ""}${grp(n)}`;
const COUNT_STATUS: Record<StockCountRow["status"], string> = { open: "belum masuk Accurate", entered: "sudah masuk Accurate", matched: "sama dengan Accurate" };
const LAST_WAREHOUSE = "pe.stock.warehouse";

/** Katalog › barang dibuka: isian cycle count (gudang + hasil hitung, menjadi draf untuk ACC admin) dan stok pembanding barang ini. */
export function StockEntry({ item, onChange }: { item: CatalogItem; onChange: (patch: SkuPatch) => void }) {
  const { can } = useAuth();
  const toast = useToast();
  const mayEnter = can("draft_catalog") || can("edit_catalog");
  const seeHistory = can("import_catalog") || can("draft_catalog");
  const [value, setValue] = useState("");
  const [warehouses, setWarehouses] = useState<string[]>([]);
  const [warehouse, setWarehouse] = useState(() => localStorage.getItem(LAST_WAREHOUSE) ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<StockHistoryRow[]>([]);
  const [counts, setCounts] = useState<StockCountRow[]>([]);
  const draft = (item.drafts ?? []).find((d) => d.kind === "stock");
  const n = Number(value.replace(",", "."));

  const loadHistory = useCallback(() => {
    if (!seeHistory) return;
    api.get<{ history: StockHistoryRow[] }>(`/stock/history?code=${encodeURIComponent(item.code)}`).then((r) => setHistory(r.history)).catch(() => {});
    api.get<{ counts: StockCountRow[] }>(`/stock/counts?code=${encodeURIComponent(item.code)}`).then((r) => setCounts(r.counts)).catch(() => {});
  }, [item.code, seeHistory]);
  useEffect(loadHistory, [loadHistory, item.stock, draft?.payload.stock]);
  useEffect(() => {
    if (!mayEnter) return;
    api.get<{ warehouses: string[] }>("/stock/warehouses").then((r) => {
      setWarehouses(r.warehouses);
      setWarehouse((w) => (r.warehouses.includes(w) ? w : r.warehouses[0] ?? ""));
    }).catch(() => {});
  }, [mayEnter]);
  if (!mayEnter && !seeHistory) return null;

  const submit = async () => {
    if (busy || !value.trim() || !Number.isFinite(n) || !warehouse) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.put<SkuPatch & { count: { accurate: number | null } }>(`/catalog/${item.id}/stock`, { stock: n, warehouse });
      onChange(r);
      localStorage.setItem(LAST_WAREHOUSE, warehouse);
      setValue("");
      const acc = r.count.accurate;
      toast(
        acc == null
          ? "Hitungan masuk draf, menunggu ACC admin. Stok Accurate gudang ini tidak terbaca."
          : `Hitungan masuk draf, menunggu ACC admin. Accurate saat ini ${grp(acc)}, selisih ${signed(n - acc)}.`,
        "success",
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Gagal menyimpan hitungan.");
    } finally {
      setBusy(false);
    }
  };

  const draftWh = draft ? String(draft.payload.warehouse ?? "") : "";
  return (
    <div className="sku-row">
      <div className="sku-head">
        <strong>Stok</strong>
        <span className="muted small">ikut Accurate, satuan dasar {item.uom}</span>
        <span className="num">{grp(item.stock)}</span>
        {draft && <span className="badge amber">hitungan {grp(Number(draft.payload.stock))}{draftWh && ` di ${draftWh}`} menunggu ACC</span>}
      </div>
      {mayEnter && (
        <div className="barcode-line">
          <select className="input" aria-label="Gudang tempat menghitung" value={warehouse} onChange={(e) => setWarehouse(e.target.value)}>
            {warehouses.map((w) => <option key={w} value={w}>{w}</option>)}
          </select>
          <input
            className={`input num${error ? " invalid" : ""}`}
            inputMode="decimal"
            placeholder="Hasil hitung"
            aria-label={`Hasil hitung ${item.name} (${item.uom})`}
            value={value}
            readOnly={busy}
            onChange={(e) => { setValue(e.target.value); setError(null); }}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void submit(); } }}
          />
          <button
            className="btn small"
            disabled={busy || !value.trim() || !Number.isFinite(n) || !warehouse}
            title="Ajukan hasil cycle count. Dibandingkan dengan stok Accurate gudang ini saat ini, lalu menunggu ACC admin."
            onClick={() => void submit()}
          >
            {busy ? "Menyimpan…" : "Ajukan hitungan"}
          </button>
        </div>
      )}
      {error && <div className="text-err small" role="alert">{error}</div>}
      {seeHistory && counts.length > 0 && (
        <details open>
          <summary className="muted small">Stok pembanding ({counts.length} hitungan)</summary>
          <ul className="draft-changes">
            {counts.slice(0, 10).map((k) => (
              <li key={k.id} className="draft-change">
                <div className="fix-main">
                  <div className="num">
                    {wib(k.counted_at)} · {k.warehouse || "gudang tidak tercatat"}: hitung <strong>{grp(k.counted)}</strong>
                    {k.accurate_qty != null && <> · Accurate saat itu {grp(k.accurate_qty)}{k.diff ? ` (${signed(k.diff)})` : ""}</>}
                  </div>
                  <div className="muted small">
                    {COUNT_STATUS[k.status]}{k.entered_ref && ` · ${k.entered_ref}`}
                    {k.counted_by_name && <> · dihitung {k.counted_by_name}</>}
                    {k.approved_by_name && <> · di-ACC {k.approved_by_name}</>}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </details>
      )}
      {seeHistory && history.length > 0 && (
        <details>
          <summary className="muted small">Riwayat stok ({history.length})</summary>
          <StockHistoryList rows={history} />
        </details>
      )}
    </div>
  );
}

/** Gudang › Menunggu ACC (admin): hitungan yang sudah di-ACC tetapi selisihnya belum masuk Accurate. */
export function OpenCountsList() {
  const toast = useToast();
  const [rows, setRows] = useState<StockCountRow[] | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.get<{ counts: StockCountRow[] }>("/stock/counts?status=open").then((r) => (setRows(r.counts), setPicked(new Set()))).catch(() => setRows([]));
  }, []);
  useEffect(() => {
    load();
    window.addEventListener("catalog-drafts-changed", load);
    return () => window.removeEventListener("catalog-drafts-changed", load);
  }, [load]);
  if (!rows?.length) return null;

  const markDone = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ done: number }>("/stock/counts/done", { ids: [...picked], note });
      toast(`${grp(r.done)} hitungan ditandai sudah masuk Accurate.`, "success");
      setConfirming(false);
      setNote("");
      window.dispatchEvent(new Event("catalog-drafts-changed"));
    } catch (e) {
      toast(e instanceof Error ? e.message : "Gagal menandai.", "error");
    } finally {
      setBusy(false);
    }
  };

  const all = rows.every((r) => picked.has(r.id));
  return (
    <section className="card-body" aria-label="Belum masuk Accurate">
      <div className="row-wrap">
        <h3>Belum masuk Accurate <span className="tab-count num">{grp(rows.length)}</span></h3>
        <span className="grow" />
        <label className="row-wrap">
          <input type="checkbox" checked={all} onChange={() => setPicked(all ? new Set() : new Set(rows.map((r) => r.id)))} aria-label="Pilih semua hitungan" />
          <span>Pilih semua</span>
        </label>
        <button className="btn primary small" disabled={!picked.size} onClick={() => setConfirming(true)}>
          Sudah masuk Accurate{picked.size ? ` (${grp(picked.size)})` : ""}
        </button>
      </div>
      <p className="muted small">
        Hitungan gudang yang sudah di-ACC. Input selisihnya sebagai penyesuaian persediaan di Accurate, di gudang yang sama.
        Kartu selesai sendiri setelah penyesuaiannya terbaca dari Accurate (paling lama ±2 jam), atau tandai di sini.
      </p>
      <ul className="draft-changes">
        {rows.map((r) => (
          <li key={r.id} className="draft-change count-row">
            <input
              type="checkbox"
              checked={picked.has(r.id)}
              onChange={() => setPicked((s) => { const n = new Set(s); n.has(r.id) ? n.delete(r.id) : n.add(r.id); return n; })}
              aria-label={`Pilih ${r.name ?? r.code}`}
            />
            <div className="fix-main">
              <div>
                <strong>{r.name ?? r.code}</strong> <span className="muted num">· {r.code}</span> · {r.warehouse || "gudang tidak tercatat"}
              </div>
              <div className="num">
                {r.diff == null ? (
                  <>Hitung {grp(r.counted)} {r.uom} · stok Accurate saat dihitung tidak tercatat, cek manual</>
                ) : (
                  <>Hitung {grp(r.counted)} · Accurate saat dihitung {grp(r.accurate_qty!)} · <strong>input di Accurate: {signed(r.diff)} {r.uom}</strong></>
                )}
              </div>
              <div className="muted small">
                dihitung {r.counted_by_name ?? "–"} {wib(r.counted_at)} · di-ACC {r.approved_by_name ?? "–"}
              </div>
            </div>
          </li>
        ))}
      </ul>
      {confirming && (
        <Modal
          title="Sudah masuk Accurate?"
          sub={`${grp(picked.size)} hitungan`}
          onClose={() => setConfirming(false)}
          footer={
            <>
              <button className="btn ghost" onClick={() => setConfirming(false)}>Batal</button>
              <button className="btn primary" disabled={busy} onClick={() => void markDone()}>{busy ? "Menyimpan…" : "Ya, sudah masuk"}</button>
            </>
          }
        >
          <p>Hitungan keluar dari daftar ini. Nama Anda dan catatannya tersimpan di stok pembanding barang itu.</p>
          <label className="field">
            <span>Catatan (opsional)</span>
            <input className="input" value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} placeholder="mis. nomor penyesuaian IA.2026.11.00020" />
          </label>
        </Modal>
      )}
    </section>
  );
}
