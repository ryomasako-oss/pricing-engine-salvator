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

interface PullResult { done: boolean; changed?: number; skipped?: number; phase?: string; itemsSeen?: number; stockRows?: number; busy?: boolean }
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
            `Stok ditarik: ${grp(r.changed ?? 0)} barang berubah${r.skipped ? `, ${grp(r.skipped)} dilewati karena perubahan ACC-nya belum terkirim ke Accurate` : ""}.`,
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
  draft_approved: "Draf di-ACC", draft_rejected: "Draf ditolak", tarik: "Tarik dari Accurate", apply: "Terapkan ke katalog", kirim: "Dikirim ke Accurate",
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
