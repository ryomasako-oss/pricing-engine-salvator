/* Jual di bawah beli (Ryoma, 2026-11-10): sales invoice (SI) lines whose net price per base unit
   is under the purchase invoice (PI) price on the invoice date — harga beli tidak boleh lebih
   tinggi dari harga jual. Same comparison as the morning recap (shared/salesBelowCost.ts), for a
   chosen date range. The filter and the Excel export work on the loaded rows, in the browser.
   Read-only; needs view_costs. */

import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { HistoryTabs } from "../components/HistoryTabs";
import { LoadError } from "../components/LoadError";
import { fmtDate, grp, rp } from "@shared/format";
import { GROUPS, groupOf, matchesCause, type GroupKey } from "@shared/belowCostHints";
import type { BelowCostRow } from "@shared/salesBelowCost";
import { LossTrace } from "../components/LossTrace";

interface Report {
  from: string;
  to: string;
  checked: number;
  unknownCost: number;
  doubtfulCost: number;
  below: BelowCostRow[];
}

const iso = (d: Date) => new Date(d.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);

export function BelowCostPage() {
  const [to, setTo] = useState(() => iso(new Date()));
  const [from, setFrom] = useState(() => iso(new Date(Date.now() - 30 * 86_400_000)));
  const [data, setData] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [q, setQ] = useState("");
  const [client, setClient] = useState("");
  const [cause, setCause] = useState<GroupKey | "">("");
  const [tracing, setTracing] = useState<BelowCostRow | null>(null);

  useEffect(() => {
    if (!from || !to) return;
    let live = true;
    setLoading(true);
    setLoadError(null);
    api
      .get<Report>(`/accurate/below-cost?from=${from}&to=${to}`)
      .then((r) => live && setData(r))
      .catch((e) => live && setLoadError(e instanceof Error ? e.message : String(e)))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [from, to, retry]);

  const clients = useMemo(() => [...new Set(data?.below.map((r) => r.customerName))].sort(), [data]);
  const rows = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return (data?.below ?? []).filter((r) => {
      if (client && r.customerName !== client) return false;
      if (!matchesCause(r.hints, cause)) return false;
      const hay = `${r.invoiceNo} ${r.customerName} ${r.code} ${r.name} ${r.receiptNo}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }, [data, q, client, cause]);
  const filtered = rows.length !== (data?.below.length ?? 0);
  const loss = rows.reduce((s, r) => s + r.lossTotal, 0);
  const byGroup = GROUPS.map((g) => {
    const rs = rows.filter((r) => groupOf(r.hints).key === g.key);
    return { ...g, rows: rs.length, loss: rs.reduce((s, r) => s + r.lossTotal, 0) };
  });

  return (
    <main className="hk-main page-stack">
      <HistoryTabs />
      <div className="hk-page-head">
        <div>
          <h1>Jual di bawah beli</h1>
          <p>
            Baris faktur penjualan (SI) yang harga bersihnya (setelah diskon, sebelum PPN, per satuan dasar) lebih rendah dari
            harga faktur pembelian (PI) terakhir pada atau sebelum tanggal SI. Harga beli tidak boleh lebih tinggi dari harga
            jual — setiap baris di sini perlu ditindaklanjuti.
          </p>
        </div>
      </div>

      <div className="card">
        <div className="toolbar">
          <label className="row">
            <span className="muted small">Dari</span>
            <input className="input" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} aria-label="Tanggal SI dari" />
          </label>
          <label className="row">
            <span className="muted small">Sampai</span>
            <input className="input" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} aria-label="Tanggal SI sampai" />
          </label>
          <input
            className="input toolbar-search"
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Cari SI, klien, kode/nama barang, PI"
            aria-label="Filter laporan"
          />
          <select className="select inline" value={client} onChange={(e) => setClient(e.target.value)} aria-label="Filter klien">
            <option value="">Semua klien</option>
            {clients.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <select className="select inline" value={cause} onChange={(e) => setCause(e.target.value as GroupKey | "")} aria-label="Filter penyebab">
            <option value="">Semua penyebab</option>
            {GROUPS.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </select>
          <span className="grow" />
          <button
            className="btn"
            disabled={!rows.length}
            onClick={async () => (await import("../export/belowCost")).exportBelowCost(rows, from, to)}
          >
            Export Excel
          </button>
        </div>
      </div>

      {loadError ? (
        <div className="card">
          <LoadError message={loadError} onRetry={() => setRetry((r) => r + 1)} />
        </div>
      ) : loading && !data ? (
        <div className="card">
          <div className="card-body skeleton-list" role="status" aria-label="Memuat laporan…">
            {[0, 1, 2, 3].map((i) => <span key={i} className="skeleton" />)}
          </div>
        </div>
      ) : data ? (
        <>
          <div className="kpi-grid">
            <div className={`kpi${rows.length ? " tone-warn" : ""}`}>
              <div className="label">Baris di bawah harga beli</div>
              <div className="value num">{grp(rows.length)}</div>
              <div className="foot">
                {filtered ? `terfilter dari ${grp(data.below.length)} · ` : ""}dari {grp(data.checked)} baris SI yang dibandingkan · total selisih{" "}
                {rp(loss)}
              </div>
              <div className="foot">
                {grp(data.unknownCost)} baris tanpa PI sebelumnya dan {grp(data.doubtfulCost)} baris dengan harga PI meragukan tidak ikut dibandingkan
              </div>
            </div>
            {byGroup.map((g) => (
              <button
                key={g.key}
                type="button"
                className={`kpi kpi-btn${cause === g.key ? " on" : ""}${g.key === "data" && g.rows ? " tone-warn" : ""}`}
                onClick={() => setCause(cause === g.key ? "" : g.key)}
                aria-pressed={cause === g.key}
                title={g.why}
              >
                <div className="label">{g.label}</div>
                <div className="value num">{rp(g.loss)}</div>
                <div className="foot">{grp(g.rows)} baris · klik untuk menyaring</div>
              </button>
            ))}
          </div>

          <details className="card guide">
            <summary>Cara membaca kolom Penyebab</summary>
            <div className="card-body guide-body">
              {GROUPS.map((g) => (
                <div key={g.key}>
                  <span className={`badge ${g.tone}`}>{g.label}</span>
                  <p>{g.why}</p>
                  <p className="muted">Yang dilakukan: {g.todo}</p>
                </div>
              ))}
            </div>
          </details>

          <div className={`card${loading ? " is-stale" : ""}`}>
            {rows.length === 0 ? (
              <div className="card-body empty">
                {filtered ? (
                  <>
                    <h3>Tidak ada baris yang cocok dengan filter</h3>
                    <p>Ubah kata kunci atau pilih "Semua klien".</p>
                  </>
                ) : (
                  <>
                    <h3>Tidak ada penjualan di bawah harga beli</h3>
                    <p>Semua baris SI pada {fmtDate(data.from)} – {fmtDate(data.to)} dijual di atas harga PI.</p>
                  </>
                )}
              </div>
            ) : (
              <div className="table-wrap">
                <table className="table stack">
                  <thead>
                    <tr>
                      <th className="l">Nomor SI</th>
                      <th className="l">Tanggal</th>
                      <th className="l">Klien</th>
                      <th className="l">Barang</th>
                      <th>Harga jual (sblm PPN)</th>
                      <th>Harga beli PI (sblm PPN)</th>
                      <th>Selisih (beli − jual)</th>
                      <th className="l">Penyebab</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <tr key={r.invoiceNo + r.code + i}>
                        <td className="l num nowrap stack-title">{r.invoiceNo}</td>
                        <td className="l nowrap" data-label="Tanggal">{fmtDate(r.transDate)}</td>
                        <td className="l" data-label="Klien">{r.customerName}</td>
                        <td className="l" data-label="Barang">
                          <div>
                            {r.name}
                            <div className="muted small">{r.code}</div>
                          </div>
                        </td>
                        <td className="num nowrap" data-label="Harga jual">{rp(r.net)}</td>
                        <td className="num nowrap" data-label="Harga beli (PI)">
                          <div>
                            {rp(r.cost)}
                            <div className="muted small">{r.receiptNo}</div>
                          </div>
                        </td>
                        <td className="num nowrap" data-label="Selisih (beli − jual)">
                          <strong>{rp(r.lossTotal)}</strong>
                        </td>
                        <td className="l" data-label="Penyebab">
                          <ul className="hint-list">
                            <li>
                              <span className={`badge ${groupOf(r.hints).tone}`}>{groupOf(r.hints).label}</span>
                            </li>
                            {r.hints.map((h) => (
                              <li key={h.kind} className="muted small" title={h.detail}>
                                {h.label}
                              </li>
                            ))}
                          </ul>
                          <button type="button" className="link-btn small" onClick={() => setTracing(r)} aria-label={`Telusuri ${r.invoiceNo} ${r.code}`}>
                            Telusuri ›
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      ) : null}
      {tracing && <LossTrace row={tracing} onClose={() => setTracing(null)} />}
    </main>
  );
}
