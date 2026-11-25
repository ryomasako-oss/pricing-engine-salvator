/* Gudang › Stok pembanding (2026-11-25): daftar seluruh stok mandiri, satu baris per barang yang pernah dihitung, satu
   kolom per gudang + pemilik. Stok Accurate PT hanya pembanding. Hanya Admin dan Admin Gudang. Server: GET /api/stock/book. */

import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { LoadError } from "../components/LoadError";
import { grp } from "@shared/format";
import { BOOK_OWNER, type BookColumn, type BookRow } from "@shared/stockBook";
import { exportStockBook } from "../export/stockBook";

const when = (s: string) => s.slice(0, 16).replace(/^(\d{4})-(\d{2})-(\d{2})/, "$3/$2/$1");

export function StockBookTable() {
  const [data, setData] = useState<{ columns: BookColumn[]; rows: BookRow[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [warehouse, setWarehouse] = useState("");
  const [onlyDiff, setOnlyDiff] = useState(false);
  const load = () => {
    setError(null);
    api.get<{ columns: BookColumn[]; rows: BookRow[] }>("/stock/book").then(setData).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  };
  useEffect(load, []);

  const warehouses = useMemo(() => [...new Set((data?.columns ?? []).map((c) => c.warehouse))], [data]);
  const columns = (data?.columns ?? []).filter((c) => !warehouse || c.warehouse === warehouse);
  const rows = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return (data?.rows ?? []).filter((r) =>
      words.every((w) => `${r.code} ${r.name ?? ""}`.toLowerCase().includes(w)) &&
      (!warehouse || columns.some((c) => r.cells[c.key] !== undefined)) &&
      (!onlyDiff || (r.diff ?? 0) !== 0),
    );
  }, [data, q, warehouse, onlyDiff, columns]);

  if (error) return <LoadError message={error} onRetry={load} />;
  if (!data) return <div className="card-body skeleton-list" role="status" aria-label="Memuat…"><span className="skeleton" /></div>;
  if (!data.rows.length)
    return (
      <div className="card-body empty">
        <h3>Belum ada stok pembanding</h3>
        <p className="muted">Hitungan gudang yang sudah di-ACC tampil di sini.</p>
      </div>
    );
  return (
    <div className="card-body">
      <p className="muted small">
        Stok mandiri di Pricing Engine dari hitungan gudang yang sudah di-ACC: angka terakhir per gudang dan pemilik. Tidak
        terhubung ke Accurate. Kolom Accurate PT hanya pembanding, untuk gudang yang dihitung (pemilik CV tidak dibandingkan).
      </p>
      <div className="row-wrap">
        <input className="input" placeholder="Cari kode atau nama barang" aria-label="Cari stok pembanding" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="input" aria-label="Filter gudang" value={warehouse} onChange={(e) => setWarehouse(e.target.value)}>
          <option value="">Semua gudang</option>
          {warehouses.map((w) => <option key={w} value={w}>{w || "(tanpa gudang)"}</option>)}
        </select>
        <label className="row-wrap"><input type="checkbox" checked={onlyDiff} onChange={(e) => setOnlyDiff(e.target.checked)} /> <span>Hanya yang selisih</span></label>
        <span className="grow" />
        <span className="muted small">{grp(rows.length)} barang</span>
        <button className="btn small ghost" onClick={() => exportStockBook(columns, rows)}>Unduh Excel</button>
      </div>
      <div className="table-wrap flush">
        <table className="table">
          <thead>
            <tr>
              <th className="l">Barang</th>
              <th className="l">Satuan</th>
              {columns.map((c) => <th key={c.key}>{c.warehouse || "(tanpa gudang)"} · {BOOK_OWNER[c.owner]}</th>)}
              <th>Total</th>
              <th title="Stok Accurate PT di gudang yang dihitung (Umum/PT)">Accurate PT</th>
              <th>Selisih</th>
              <th className="l">Terakhir dihitung</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.code}>
                <td className="l">
                  <Link to={`/gudang/stok/${encodeURIComponent(r.code)}`}>{r.name ?? r.code}</Link> <span className="muted num">· {r.code}</span>
                </td>
                <td className="l">{r.uom}</td>
                {columns.map((c) => <td key={c.key} className="num">{r.cells[c.key] === undefined ? "–" : grp(r.cells[c.key])}</td>)}
                <td className="num"><strong>{grp(r.total)}</strong></td>
                <td className="num muted" title={`Semua gudang: ${grp(r.accurateAll)}`}>{r.accurate == null ? "–" : grp(r.accurate)}</td>
                <td className={`num ${r.diff ? "text-err" : ""}`}>{r.diff == null ? "–" : `${r.diff > 0 ? "+" : ""}${grp(r.diff)}`}</td>
                <td className="l small">{when(r.lastAt)}{r.lastBy && ` · ${r.lastBy}`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
