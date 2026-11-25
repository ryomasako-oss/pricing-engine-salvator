/* Riwayat stok satu barang (2026-11-25): per gudang, stok Accurate terakhir, setiap gerakan stok dari Accurate dengan
   saldo sesudahnya (dihitung mundur dari stok sekarang), dan hasil cycle count sebagai pembanding. Tanda ⚠ di titik
   saldo pertama kali minus dan di transaksi yang tanggalnya lebih awal dari waktu dibuat. Server: GET /api/stock/item. */

import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../api";
import { LoadError } from "../components/LoadError";
import { grp } from "@shared/format";
import type { TimelineEvent } from "@shared/stockTimeline";

interface WarehouseHistory { warehouse: string; accurate: number; asOf: string | null; events: TimelineEvent[] }
interface ItemHistory {
  item: { code: string; name: string | null; uom: string; stock: number | null };
  warehouses: WarehouseHistory[];
  noWarehouse: { id: number; counted: number; counted_wib: string; counted_by_name: string | null }[];
  historyFrom: string | null;
}

const TYPE: Record<string, string> = {
  DO: "Pengiriman", SI: "Faktur penjualan", RI: "Penerimaan", PI: "Faktur pembelian", IA: "Penyesuaian",
  IT: "Pindah gudang", SRT: "Retur penjualan", PRT: "Retur pembelian",
};
const typeName = (t: string, n: string) => TYPE[t] ?? TYPE[n.split(".")[0]] ?? t;
const signed = (n: number) => `${n > 0 ? "+" : ""}${grp(n)}`;
const when = (s: string) => s.slice(0, 16).replace(/^(\d{4})-(\d{2})-(\d{2})/, "$3/$2/$1");

export function StockItemHistoryPage() {
  const { code = "" } = useParams();
  const [data, setData] = useState<ItemHistory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => {
    setError(null);
    api.get<ItemHistory>(`/stock/item?code=${encodeURIComponent(code)}`).then(setData).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  };
  useEffect(load, [code]);

  return (
    <main className="hk-main page-stack">
      <div className="hk-page-head">
        <div>
          <p className="muted small"><Link to="/gudang">Gudang</Link> › Riwayat stok</p>
          <h1>{data?.item.name ?? code}</h1>
          <p>
            <span className="num">{code}</span>
            {data?.item.uom && <> · satuan dasar {data.item.uom}</>}
            {data?.historyFrom && <> · riwayat gerakan stok tersimpan sejak {when(data.historyFrom)} WIB</>}
          </p>
        </div>
      </div>
      {error ? (
        <LoadError message={error} onRetry={load} />
      ) : !data ? (
        <div className="card card-body skeleton-list" role="status" aria-label="Memuat riwayat…"><span className="skeleton" /></div>
      ) : data.warehouses.length === 0 && data.noWarehouse.length === 0 ? (
        <div className="card card-body empty"><h3>Belum ada stok atau gerakan stok untuk barang ini</h3></div>
      ) : (
        <>
          {data.warehouses.map((w) => (
            <section key={w.warehouse} className="card" aria-label={`Gudang ${w.warehouse}`}>
              <div className="card-head">
                <h3>{w.warehouse}</h3>
                <span className={`num ${w.accurate < 0 ? "text-err" : ""}`}>
                  Accurate sekarang <strong>{grp(w.accurate)}</strong>{w.asOf && <span className="muted small"> · per {when(w.asOf)} WIB</span>}
                </span>
              </div>
              <div className="card-body">
                {w.events.length === 0 ? (
                  <p className="muted small">Belum ada gerakan stok tersimpan untuk gudang ini.</p>
                ) : (
                  <div className="table-wrap flush">
                    <table className="table stack">
                      <thead>
                        <tr>
                          <th className="l">Waktu dibuat</th>
                          <th className="l">Kejadian</th>
                          <th>Gerak</th>
                          <th>Saldo sesudah</th>
                          <th className="l">Catatan</th>
                        </tr>
                      </thead>
                      <tbody>
                        {w.events.map((e, i) =>
                          e.kind === "count" ? (
                            <tr key={`c${e.c.id}`} className="row-open">
                              <td className="l num">{when(e.at)}</td>
                              <td className="l"><strong>Cycle count</strong>{e.c.counted_by_name && <span className="muted"> · {e.c.counted_by_name}</span>}</td>
                              <td className="num">hitung {grp(e.c.counted)}</td>
                              <td className="num">{e.balance == null ? "–" : grp(e.balance)}</td>
                              <td className="l small">
                                {e.gap == null ? "di luar riwayat tersimpan" : e.gap === 0 ? "sama dengan saldo" : <span className="text-err">fisik {signed(e.gap)} dari saldo</span>}
                              </td>
                            </tr>
                          ) : (
                            <tr key={`m${e.m.id}-${i}`} className={e.wentNegative ? "flagged" : ""}>
                              <td className="l num">{when(e.at)}</td>
                              <td className="l">
                                {typeName(e.m.type, e.m.number)} <span className="muted num">· {e.m.number}</span>
                                {e.m.removed && <span className="badge grey"> dihapus di Accurate</span>}
                              </td>
                              <td className="num">{signed(e.m.qty)}</td>
                              <td className={`num ${e.balance < 0 ? "text-err" : ""}`}>{grp(e.balance)}</td>
                              <td className="l small">
                                {e.wentNegative && <span className="text-err">⚠ minus mulai di sini. </span>}
                                {e.backdated && <span>⚠ tanggal transaksi {when(e.m.trans_date!)} (mundur). </span>}
                              </td>
                            </tr>
                          ),
                        )}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </section>
          ))}
          {data.noWarehouse.length > 0 && (
            <section className="card" aria-label="Hitungan tanpa gudang">
              <div className="card-head"><h3>Hitungan lama tanpa gudang</h3></div>
              <ul className="card-body plain">
                {data.noWarehouse.map((k) => (
                  <li key={k.id} className="num">{when(k.counted_wib)} · hitung {grp(k.counted)}{k.counted_by_name && ` · ${k.counted_by_name}`}</li>
                ))}
              </ul>
            </section>
          )}
          <p className="muted small">
            Saldo dihitung mundur dari stok Accurate terakhir lewat gerakan stok yang tersimpan, urut waktu dibuat di Accurate.
            Gerakan sebelum riwayat tersimpan tidak terlihat.
          </p>
        </>
      )}
    </main>
  );
}

interface MinusRow { code: string; name: string | null; uom: string | null; warehouse: string; qty: number; synced_at: string }

/** Gudang › Stok minus: barang yang stoknya minus di satu gudang menurut salinan Accurate terakhir. */
export function StockMinusList() {
  const [rows, setRows] = useState<MinusRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.get<{ items: MinusRow[] }>("/stock/minus").then((r) => setRows(r.items)).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  if (error) return <LoadError message={error} onRetry={() => location.reload()} />;
  if (!rows) return <div className="card-body skeleton-list" role="status" aria-label="Memuat…"><span className="skeleton" /></div>;
  if (!rows.length) return <div className="card-body empty"><h3>Tidak ada stok minus</h3></div>;
  return (
    <div className="card-body">
      <p className="muted small">
        {grp(rows.length)} baris stok minus per gudang di Accurate. Buka barangnya untuk melihat transaksi yang membuatnya minus.
      </p>
      <div className="table-wrap flush">
        <table className="table stack">
          <thead>
            <tr>
              <th className="l">Barang</th>
              <th className="l">Gudang</th>
              <th>Stok Accurate</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.code}|${r.warehouse}`}>
                <td className="l">
                  <Link to={`/gudang/stok/${encodeURIComponent(r.code)}`}>{r.name ?? r.code}</Link> <span className="muted num">· {r.code}</span>
                </td>
                <td className="l">{r.warehouse}</td>
                <td className="num text-err">{grp(r.qty)} {r.uom ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
