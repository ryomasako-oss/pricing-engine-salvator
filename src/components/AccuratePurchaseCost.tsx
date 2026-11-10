/* COGS dari harga pembelian terakhir (server/worker/accurate/purchaseCost.ts).
   A manager previews what the latest Accurate goods receipts would change in
   the catalog, then applies it. Nothing changes until "Terapkan". A big jump
   still holds quote lines until the manager confirms it ("COGS ini benar").
   A change too far off (purchaseCostHold) is never applied: it is listed as
   "ditahan" so the manager fixes the RI in Accurate or sets the COGS by hand,
   or, after checking it, ticks it and applies it as the COGS and its
   reference (POST /accurate/apply-held-cogs, at the price shown). */

import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { useToast } from "../context/ToastContext";
import { ConfirmModal } from "./Modal";
import { fmtDate, fmtDateTime, grp, pct, rp } from "@shared/format";

interface ReceiptStatus {
  entity: string;
  enabled: boolean;
  inProgress: boolean;
  receiptsSeen: number;
  lastPassAt: string | null;
  lastError: string | null;
}

interface Change {
  code: string;
  name: string;
  from: number;
  to: number;
  receiptNo: string;
  transDate: string;
}

interface Held extends Change {
  listPrice: number;
  reason: string;
}

interface Skip {
  code: string;
  name: string;
  reason: "uom_mismatch" | "unknown_unit";
  detail: string;
}

interface HeldApplied {
  applied: Held[];
  stale: { code: string; to: number }[];
}

interface Preview {
  withReceipt: number;
  changed: Change[];
  held: Held[];
  unchanged: number;
  skipped: Skip[];
  noReceipt: number;
  /** Last sales-invoice price per catalog unit, by code (empty while SI sync is off). */
  lastSales?: Record<string, { price: number; invoiceNo: string; date: string }>;
}

/** The last selling price beside the new COGS: red when the item last sold under it. */
function LastSale({ sale, cogs }: { sale?: { price: number; invoiceNo: string; date: string }; cogs: number }) {
  if (!sale) return <td className="muted">—</td>;
  const under = sale.price < cogs;
  return (
    <td title={under ? "Terakhir dijual di bawah COGS baru" : undefined}>
      <span className={under ? "text-err" : undefined}>{rp(sale.price)}</span>
      <div className="muted">
        {sale.invoiceNo} · {fmtDate(sale.date)}
      </div>
    </td>
  );
}

/* Big jumps are listed first: they are the ones a manager should look at, and cogsCheck holds them anyway. */
const SHOWN = 100;
const BIG_JUMP = 0.5;
const jump = (c: Change) => (c.from > 0 ? (c.to - c.from) / c.from : Infinity);

/** Polled only while a pass runs: one row read on the server. */
const STATUS_POLL_MS = 60_000;

export function AccuratePurchaseCost({ onApplied }: { onApplied: () => void }) {
  const toast = useToast();
  const [status, setStatus] = useState<ReceiptStatus | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [showSkipped, setShowSkipped] = useState(false);
  const [showHeld, setShowHeld] = useState(true);
  const [busy, setBusy] = useState<"preview" | "apply" | "held" | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [asking, setAsking] = useState<null | "apply" | "held">(null);

  const loadStatus = useCallback(() => {
    api.get<ReceiptStatus>("/accurate/receipts").then(setStatus).catch(() => setStatus(null));
  }, []);
  useEffect(loadStatus, [loadStatus]);

  const collecting = !!status?.inProgress && !status.lastPassAt;
  useEffect(() => {
    if (!collecting) return;
    const t = setInterval(() => {
      if (!document.hidden) loadStatus();
    }, STATUS_POLL_MS);
    return () => clearInterval(t);
  }, [collecting, loadStatus]);

  if (!status) return null;

  const runPreview = async () => {
    setBusy("preview");
    try {
      const r = await api.post<Preview>("/accurate/apply-cogs", { dryRun: true });
      r.changed.sort((a, b) => Math.abs(jump(b)) - Math.abs(jump(a)) || a.code.localeCompare(b.code));
      setPreview(r);
      setPicked(new Set());
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(null);
    }
  };

  const apply = async () => {
    if (!preview) return;
    setAsking(null);
    setBusy("apply");
    try {
      const r = await api.post<Preview>("/accurate/apply-cogs", { dryRun: false });
      toast(`COGS ${grp(r.changed.length)} barang diperbarui dari harga pembelian terakhir.`);
      setPreview(null);
      onApplied();
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(null);
      loadStatus();
    }
  };

  const togglePick = (code: string) =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(code)) n.delete(code);
      else n.add(code);
      return n;
    });

  const applyHeld = async () => {
    if (!preview) return;
    const items = preview.held.filter((h) => picked.has(h.code));
    if (!items.length) return;
    setAsking(null);
    setBusy("held");
    try {
      const r = await api.post<HeldApplied>("/accurate/apply-held-cogs", { items: items.map((h) => ({ code: h.code, to: h.to })) });
      toast(
        `COGS ${grp(r.applied.length)} barang yang ditahan diterapkan.` +
          (r.stale.length ? ` ${grp(r.stale.length)} dilewati karena harganya sudah berubah; pratinjau dimuat ulang.` : ""),
        r.stale.length ? "error" : undefined,
      );
      onApplied();
      setBusy(null);
      await runPreview();
    } catch (e) {
      toast((e as Error).message, "error");
      setBusy(null);
    }
  };

  return (
    <div className="subsection">
      <div className="row-between">
        <div>
          <strong>COGS dari harga pembelian terakhir</strong>{" "}
          {!status.enabled ? (
            <span className="badge grey">Belum aktif</span>
          ) : status.lastError ? (
            <span className="badge red">Error</span>
          ) : collecting ? (
            <span className="badge blue">Mengumpulkan riwayat</span>
          ) : (
            <span className="badge green">Siap</span>
          )}
          <div className="muted small">
            Harga satuan faktur pembelian (PI) terakhir per barang di Accurate {status.entity}, sebelum PPN.
            {collecting && ` Riwayat setahun sedang dikumpulkan: ${grp(status.receiptsSeen)} PI terbaca. Pratinjau tersedia setelah selesai.`}
            {status.lastPassAt && ` Riwayat terakhir diperbarui ${fmtDateTime(status.lastPassAt)}.`}
          </div>
          {status.lastError && <div className="small text-err">{status.lastError}</div>}
        </div>
        <div className="row-wrap">
          <button className="btn small ghost" disabled={!!busy || !status.lastPassAt} onClick={runPreview}>
            {busy === "preview" ? "Menghitung…" : "Pratinjau"}
          </button>
          <Link className="btn small ghost" to="/cogs-history">
            Cari riwayat COGS
          </Link>
          <Link className="btn small ghost" to="/sales-history">
            Cari riwayat SI
          </Link>
          {preview && preview.changed.length > 0 && (
            <button className="btn small" disabled={!!busy} onClick={() => setAsking("apply")}>
              {busy === "apply" ? "Menerapkan…" : `Terapkan ${grp(preview.changed.length)} perubahan`}
            </button>
          )}
        </div>
      </div>

      {preview && (
        <div className="small note-block">
          <div className="row-wrap">
            <span className="badge amber">{grp(preview.changed.length)} berubah</span>
            <span className="badge green">{grp(preview.unchanged)} sudah sama</span>
            {preview.held.length > 0 && (
              <button
                className="badge red"
                style={{ border: 0, cursor: "pointer" }}
                onClick={() => setShowHeld((v) => !v)}
                aria-expanded={showHeld}
              >
                {grp(preview.held.length)} ditahan
              </button>
            )}
            <button
              className="badge grey"
              style={{ border: 0, cursor: preview.skipped.length ? "pointer" : "default" }}
              disabled={!preview.skipped.length}
              onClick={() => setShowSkipped((v) => !v)}
              aria-expanded={showSkipped}
            >
              {grp(preview.skipped.length)} dilewati (satuan)
            </button>
            <span className="badge grey">{grp(preview.noReceipt)} tanpa PI, COGS tetap</span>
          </div>

          {showHeld && preview.held.length > 0 && (
            <>
              <div className="muted note-block">
                Tidak ikut diterapkan: harga beli 3x harga jual atau lebih, atau jauh (lebih dari dua kali / kurang dari separuh) dari COGS sekarang
                dan dari harga beli di PI sebelumnya. Biasanya satu pak/box tercatat 1 PCS di PI. Betulkan PI di Accurate, isi COGS manual di
                katalog, atau kalau harganya memang benar, centang lalu terapkan.
              </div>
              <div className="row-wrap note-block">
                <button className="btn small" disabled={!!busy || picked.size === 0} onClick={() => setAsking("held")}>
                  {busy === "held" ? "Menerapkan…" : picked.size ? `Terapkan ${grp(picked.size)} yang dicentang` : "Centang barang yang harganya benar"}
                </button>
              </div>
              <div className="table-wrap note-block">
                <table className="table">
                  <thead>
                    <tr>
                      <th className="l">
                        <input
                          type="checkbox"
                          aria-label="Centang semua yang ditampilkan"
                          checked={preview.held.slice(0, SHOWN).every((h) => picked.has(h.code))}
                          onChange={(e) => setPicked(e.target.checked ? new Set(preview.held.slice(0, SHOWN).map((h) => h.code)) : new Set())}
                        />
                      </th>
                      <th className="l">Kode</th>
                      <th className="l">Nama</th>
                      <th>COGS sekarang</th>
                      <th>Pembelian terakhir</th>
                      <th>Jual terakhir (SI)</th>
                      <th className="l">Kenapa ditahan</th>
                      <th className="l">Sumber</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {preview.held.slice(0, SHOWN).map((h) => (
                      <tr key={h.code}>
                        <td className="l">
                          <input type="checkbox" aria-label={`Centang ${h.code}`} checked={picked.has(h.code)} onChange={() => togglePick(h.code)} />
                        </td>
                        <td className="l">{h.code}</td>
                        <td className="l">{h.name}</td>
                        <td>{h.from > 0 ? rp(h.from) : "kosong"}</td>
                        <td>{rp(h.to)}</td>
                        <LastSale sale={preview.lastSales?.[h.code]} cogs={h.to} />
                        <td className="l">{h.reason}</td>
                        <td className="l muted">
                          {h.receiptNo} · {fmtDate(h.transDate)}
                        </td>
                        <td className="l">
                          <Link to={`/cogs-history?q=${encodeURIComponent(h.code)}`}>COGS ›</Link>{" "}
                          <Link to={`/sales-history?q=${encodeURIComponent(h.code)}`}>SI ›</Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {preview.held.length > SHOWN && <div className="muted">Menampilkan {SHOWN} dari {grp(preview.held.length)}.</div>}
              </div>
            </>
          )}

          {showSkipped && preview.skipped.length > 0 && (
            <div className="table-wrap note-block">
              <table className="table">
                <thead>
                  <tr>
                    <th className="l">Kode</th>
                    <th className="l">Nama</th>
                    <th className="l">Kenapa dilewati</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.skipped.slice(0, SHOWN).map((s) => (
                    <tr key={s.code}>
                      <td className="l">{s.code}</td>
                      <td className="l">{s.name}</td>
                      <td className="l">{s.detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {preview.skipped.length > SHOWN && <div className="muted">Menampilkan {SHOWN} dari {grp(preview.skipped.length)}.</div>}
            </div>
          )}

          {preview.changed.length === 0 ? (
            <p className="muted note-block">Tidak ada COGS yang berubah.</p>
          ) : (
            <div className="table-wrap note-block">
              <table className="table">
                <thead>
                  <tr>
                    <th className="l">Kode</th>
                    <th className="l">Nama</th>
                    <th>COGS sekarang</th>
                    <th>Pembelian terakhir</th>
                    <th>Selisih</th>
                    <th>Jual terakhir (SI)</th>
                    <th className="l">Sumber</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {preview.changed.slice(0, SHOWN).map((c) => {
                    const j = jump(c);
                    return (
                      <tr key={c.code}>
                        <td className="l">{c.code}</td>
                        <td className="l">{c.name}</td>
                        <td>{c.from > 0 ? rp(c.from) : "kosong"}</td>
                        <td>{rp(c.to)}</td>
                        <td className={Math.abs(j) > BIG_JUMP ? "text-err" : undefined}>
                          {Number.isFinite(j) ? `${j > 0 ? "+" : ""}${pct(j)}` : "baru"}
                        </td>
                        <LastSale sale={preview.lastSales?.[c.code]} cogs={c.to} />
                        <td className="l muted">
                          {c.receiptNo} · {fmtDate(c.transDate)}
                        </td>
                        <td className="l">
                          <Link to={`/cogs-history?q=${encodeURIComponent(c.code)}`}>COGS ›</Link>{" "}
                          <Link to={`/sales-history?q=${encodeURIComponent(c.code)}`}>SI ›</Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {preview.changed.length > SHOWN && (
                <div className="muted">
                  Menampilkan {SHOWN} perubahan terbesar dari {grp(preview.changed.length)}. "Terapkan" mengubah semuanya.
                </div>
              )}
            </div>
          )}
        </div>
      )}
      {asking === "apply" && preview && (
        <ConfirmModal
          title={`Ubah COGS ${grp(preview.changed.length)} barang?`}
          tone="primary"
          message={
            <>
              COGS diganti ke harga pembelian terakhir.
              {preview.changed.filter((c) => Math.abs(jump(c)) > BIG_JUMP).length > 0 &&
                ` ${grp(preview.changed.filter((c) => Math.abs(jump(c)) > BIG_JUMP).length)} barang berubah lebih dari 50%: barisnya di quotation ditahan sampai manajer menekan "COGS ini benar".`}
              {preview.held.length > 0 && ` ${grp(preview.held.length)} barang ditahan dan tidak ikut diubah.`} COGS acuan tidak
              berubah; barang yang dilewati tetap memakai COGS lamanya.
            </>
          }
          confirmLabel="Ubah COGS"
          busy={busy === "apply"}
          onConfirm={() => void apply()}
          onClose={() => setAsking(null)}
        />
      )}
      {asking === "held" && preview && (
        <ConfirmModal
          title={`Terapkan harga untuk ${grp(picked.size)} barang yang ditahan?`}
          tone="primary"
          message='COGS dan COGS acuannya ikut diubah, sama seperti menekan "COGS ini benar". Pastikan PI-nya sudah dicek.'
          confirmLabel="Terapkan"
          busy={busy === "held"}
          onConfirm={() => void applyHeld()}
          onClose={() => setAsking(null)}
        />
      )}
    </div>
  );
}
