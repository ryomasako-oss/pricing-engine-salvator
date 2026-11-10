/* "Telusuri" one loss row of Jual < Beli (pemilik, 2026-11-10: "kita harus ngetrack itu salahnya
   dimana: salah input, salah satuan, emang salah harga, atau yang lain?"). Shows the SI and the PI as
   recorded, the item's recent PIs and SIs (the Riwayat PI/SI endpoints), and the conclusion from the
   marks. A dialog, not a page, so the menu stays as it is. Needs view_costs, like the report. */

import { useEffect, useState } from "react";
import { api } from "../api";
import { fmtDate, grp, rp } from "@shared/format";
import { looksLikeSlip } from "@shared/belowCostHints";
import type { BelowCostRow } from "@shared/salesBelowCost";
import { Modal } from "./Modal";
import { LoadError } from "./LoadError";

interface Purchases {
  cards: { code: string; purchases: { invoiceNo: string; transDate: string; unit: string; quantity: number; invoicePrice: number; price: number; inclusiveTax: boolean }[] }[];
}
interface Sales {
  cards: { code: string; baseUom: string; sales: { invoiceNo: string; transDate: string; customerName: string; detailName: string; unit: string; quantity: number; perBase: number | null }[] }[];
}

export function LossTrace({ row, onClose }: { row: BelowCostRow; onClose: () => void }) {
  const [hist, setHist] = useState<{ buy: Purchases["cards"][number]["purchases"]; sell: Sales["cards"][number]["sales"] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const t = row.trace;

  useEffect(() => {
    let live = true;
    setError(null);
    const q = encodeURIComponent(row.code);
    Promise.all([api.get<Purchases>(`/accurate/purchase-history?q=${q}`), api.get<Sales>(`/accurate/sales-history?q=${q}`)])
      .then(([p, s]) => {
        // The search is a LIKE: take the card of this exact code.
        if (live) setHist({ buy: p.cards.find((c) => c.code === row.code)?.purchases ?? [], sell: s.cards.find((c) => c.code === row.code)?.sales ?? [] });
      })
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [row.code, retry]);

  const slip = looksLikeSlip(row.hints);
  const ppn = 1 + (t.taxRate > 0 ? t.taxRate : 11) / 100;
  // shortcut: an SI with no tax rate is shown at the usual 11% for comparison, and says so.
  const ppnPct = `PPN ${Math.round((ppn - 1) * 100)}%`;
  const qty = t.quantity > 0 ? t.quantity : 1;
  // The SI line as written: per invoice unit after the item discount; with PPN when the box was ticked.
  const siWritten = (t.lineAmount / qty) * (t.inclusiveTax ? ppn : 1);
  const pi = hist?.buy.find((p) => p.invoiceNo === row.receiptNo);
  const soldBase = (t.quantity - t.returnQty) * (t.unitRatio > 0 ? t.unitRatio : 1);

  return (
    <Modal title={`Telusuri ${row.invoiceNo}`} sub={`${row.name} · ${row.code}`} onClose={onClose} size="wide">
      <div className="trace">
        <div className={`notice ${slip ? "warn" : "info"}`} role="status">
          <strong>{slip ? "Perlu cek data" : "Tanpa tanda"}</strong>
          {slip ? (
            <ul className="hint-list">
              {row.hints.map((h) => (
                <li key={h.kind}>{h.label}</li>
              ))}
            </ul>
          ) : (
            <p>
              Cek otomatis satuan, PPN, input harga, dan kode barang tidak menemukan tanda. Harga jual tercatat di bawah harga beli;
              cocokkan tetap dengan nota asli
              {row.hints.length ? ` (${row.hints.map((h) => h.label).join("; ")})` : ""}.
            </p>
          )}
        </div>

        <dl className="trace-grid">
          <dt>Faktur jual (SI)</dt>
          <dd>
            {row.invoiceNo} · {fmtDate(row.transDate)} · {row.customerName}
            <div className="muted small">
              {grp(t.quantity)} {t.unit}
              {t.returnQty > 0 ? ` (retur ${grp(t.returnQty)})` : ""}
              {t.unit.trim().toLowerCase() !== t.baseUom.trim().toLowerCase() && ` · isi ${grp(t.unitRatio || 1)} ${t.baseUom} per ${t.unit} = ${grp(soldBase)} ${t.baseUom}`}
              {t.discount > 0 ? ` · diskon faktur ${Math.round(t.discount * 100)}%` : ""}
            </div>
            {t.detailName && <div className="muted small">Tertulis di faktur: "{t.detailName}"</div>}
          </dd>
          <dt>Di nota SI</dt>
          <dd>
            {rp(siWritten)} / {t.unit} {t.inclusiveTax ? `(termasuk ${ppnPct})` : t.taxRate > 0 ? "(belum termasuk PPN)" : "(SI tanpa tarif PPN)"}
            <div className="muted small">setelah diskon barang{t.discount > 0 ? ", sebelum diskon faktur" : ""}</div>
          </dd>
          <dt>Harga jual dibandingkan</dt>
          <dd className="num">
            {rp(row.net)} / {t.baseUom} sebelum PPN · {rp(row.net * ppn)} dengan {ppnPct}
          </dd>
          <dt>Faktur beli (PI) dipakai</dt>
          <dd>
            {row.receiptNo} · {fmtDate(t.receiptDate)} · dibeli per {t.receiptUnit}
          </dd>
          <dt>Di nota PI</dt>
          <dd>
            {pi ? (
              <>
                {rp(pi.invoicePrice)} / {pi.unit} {pi.inclusiveTax ? `(termasuk ${ppnPct}, dibagi ${ppn.toLocaleString("id-ID")})` : "(belum termasuk PPN)"}
                <div className="muted small">sebelum diskon</div>
              </>
            ) : hist ? (
              <span className="muted small">PI ini tidak ada di 10 PI terbaru barang ini</span>
            ) : (
              <span className="muted small">memuat…</span>
            )}
          </dd>
          <dt>Harga beli dibandingkan</dt>
          <dd className="num">
            {rp(row.cost)} / {t.baseUom} sebelum PPN · {rp(row.cost * ppn)} dengan {ppnPct}
          </dd>
          <dt>Selisih (beli − jual)</dt>
          <dd className="num">
            <strong>{rp(row.lossTotal)}</strong>
          </dd>
        </dl>

        {error ? (
          <LoadError message={error} onRetry={() => setRetry((r) => r + 1)} />
        ) : !hist ? (
          <div className="skeleton-list" role="status" aria-label="Memuat riwayat…">
            <span className="skeleton" />
            <span className="skeleton" />
          </div>
        ) : (
          <>
            <section aria-label="Riwayat beli barang ini">
              <h4>Riwayat beli barang ini (PI terbaru)</h4>
              {hist.buy.length ? (
                <table className="table trace-table">
                  <tbody>
                    {hist.buy.map((p) => (
                      <tr key={p.invoiceNo + p.transDate} className={p.invoiceNo === row.receiptNo ? "is-current" : ""}>
                        <td className="l nowrap">{fmtDate(p.transDate)}</td>
                        <td className="l">{p.invoiceNo}</td>
                        <td className="nowrap">
                          {grp(p.quantity)} {p.unit}
                        </td>
                        <td className="num nowrap">
                          {rp(p.invoicePrice)} / {p.unit}
                          <div className="muted small">{p.inclusiveTax ? `di nota, termasuk ${ppnPct}` : "di nota, belum PPN"}</div>
                        </td>
                        <td className="num nowrap">
                          {rp(p.price)} / {p.unit}
                          <div className="muted small">bersih, sebelum PPN</div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="muted small">Belum ada PI.</p>
              )}
            </section>
            <section aria-label="Riwayat jual barang ini">
              <h4>Riwayat jual barang ini (SI terbaru)</h4>
              {hist.sell.length ? (
                <table className="table trace-table">
                  <tbody>
                    {hist.sell.map((s) => (
                      <tr key={s.invoiceNo + s.transDate + s.unit} className={s.invoiceNo === row.invoiceNo ? "is-current" : ""}>
                        <td className="l nowrap">{fmtDate(s.transDate)}</td>
                        <td className="l">
                          {s.customerName}
                          {s.detailName && <div className="muted small">"{s.detailName}"</div>}
                        </td>
                        <td className="nowrap">
                          {grp(s.quantity)} {s.unit}
                        </td>
                        <td className="num nowrap">{s.perBase === null ? "retur" : `${rp(s.perBase)} / ${t.baseUom}`}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="muted small">Belum ada SI lain.</p>
              )}
            </section>
          </>
        )}
        <p className="muted small">
          Baris yang ditandai adalah faktur yang sedang ditelusuri. Angka "di nota" bisa dicocokkan langsung dengan nota SI/PI di Accurate; bila
          berbeda, data di Accurate yang dibetulkan, dan laporan ini ikut berubah setelah sinkron.
        </p>
      </div>
    </Modal>
  );
}
