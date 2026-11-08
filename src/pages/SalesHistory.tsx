/* Riwayat penjualan (SI): one card per catalog item with its latest sales-invoice
   lines and the wordings it was invoiced under, to check a match against what
   was actually sold. Search takes a code, a name, a client's wording or a
   customer. Read-only; needs view_costs, like Riwayat COGS. */

import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { useToast } from "../context/ToastContext";
import { Icon } from "../components/Icon";
import { fmtDate, grp, rp } from "@shared/format";

interface Card {
  code: string;
  name: string;
  uom: string;
  baseUom: string;
  sales: {
    invoiceNo: string;
    transDate: string;
    customerName: string;
    detailName: string;
    unit: string;
    quantity: number;
    price: number | null;
    perBase: number | null;
  }[];
  names: { name: string; count: number }[];
}

interface Page {
  total: number;
  page: number;
  pageSize: number;
  cards: Card[];
}

export function SalesHistoryPage() {
  const toast = useToast();
  // Pencocokan's "Riwayat SI" links arrive here as /sales-history?q=<kode>.
  const [params] = useSearchParams();
  const [q, setQ] = useState(params.get("q") ?? "");
  const [search, setSearch] = useState(params.get("q") ?? "");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Page | null>(null);
  const [loading, setLoading] = useState(true);

  // Typing waits half a second before asking the server.
  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(q);
      setPage(1);
    }, 500);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    let live = true;
    setLoading(true);
    api
      .get<Page>(`/accurate/sales-history?q=${encodeURIComponent(search)}&page=${page}`)
      .then((r) => live && setData(r))
      .catch((e) => live && toast(e.message, "error"))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [search, page, toast]);

  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <main className="hk-main page-stack">
      <div className="hk-page-head">
        <div>
          <Link to="/pencocokan" className="link-btn">
            <Icon name="back" size={14} /> Kembali ke Pencocokan
          </Link>
          <h1>Riwayat penjualan (SI)</h1>
          <p>
            Faktur penjualan (SI) Accurate terbaru tiap barang: ke siapa, ditulis sebagai apa, dan harganya. Cari pakai kode,
            nama katalog, tulisan klien, atau nama customer untuk mengecek pencocokan. Harga setelah diskon, sebelum PPN.
          </p>
        </div>
        <Link className="btn ghost" to="/cogs-history">
          Riwayat COGS
        </Link>
      </div>

      <div className="card">
        <div className="toolbar">
          <input
            className="input toolbar-search wide"
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Cari kode, nama barang, tulisan di faktur, atau customer"
            aria-label="Cari riwayat penjualan"
          />
          <span className="grow" />
          {data && <span className="muted small num">{grp(data.total)} barang terjual</span>}
        </div>
      </div>

      {loading && !data ? (
        <div className="card">
          <div className="card-body skeleton-list" role="status" aria-label="Memuat riwayat penjualan…">
            {[0, 1, 2, 3].map((i) => <span key={i} className="skeleton" />)}
          </div>
        </div>
      ) : !data || data.cards.length === 0 ? (
        <div className="card">
          <div className="card-body empty">
            <h3>Tidak ada penjualan yang cocok</h3>
            <p>{search ? "Coba kode barang, sebagian nama, atau nama customer." : "Belum ada faktur penjualan dari Accurate."}</p>
          </div>
        </div>
      ) : (
        <>
          <div className={`item-cards${loading ? " is-stale" : ""}`}>
            {data.cards.map((c) => (
              <section key={c.code} className="card" aria-label={c.name}>
                <div className="card-head">
                  <div className="card-title">
                    <h3>{c.name}</h3>
                    <span className="muted small">{c.code} · per {c.uom}</span>
                  </div>
                </div>
                <div className="card-body form-stack">
                  {c.names.length > 0 && (
                    <div className="row-wrap">
                      <span className="muted">Ditulis di faktur sebagai:</span>
                      {c.names.map((n) => (
                        <span key={n.name} className="badge grey">
                          {n.name} <span className="num">×{grp(n.count)}</span>
                        </span>
                      ))}
                    </div>
                  )}

                  <div className="card-section">
                    <h4 className="label-title">Faktur terbaru</h4>
                    <div className="table-wrap">
                      <table className="table">
                        <thead>
                          <tr>
                            <th className="l">Tanggal</th>
                            <th className="l">Nomor faktur</th>
                            <th className="l">Customer</th>
                            <th>Qty</th>
                            <th>Harga</th>
                          </tr>
                        </thead>
                        <tbody>
                          {c.sales.map((s, i) => (
                            <tr key={s.invoiceNo + i}>
                              <td className="l nowrap">{fmtDate(s.transDate)}</td>
                              <td className="l num nowrap">{s.invoiceNo}</td>
                              <td className="l">
                                {s.customerName || "—"}
                                {s.detailName && <div className="muted small">“{s.detailName}”</div>}
                              </td>
                              <td className="num nowrap">
                                {grp(s.quantity)} {s.unit}
                              </td>
                              <td className="num nowrap">
                                {s.price === null ? (
                                  <span className="badge grey">Diretur semua</span>
                                ) : (
                                  <>
                                    {rp(s.price)} / {s.unit || c.baseUom}
                                    {s.unit && s.unit.toLowerCase() !== c.baseUom.toLowerCase() && (
                                      <div className="muted small">
                                        {rp(s.perBase!)} / {c.baseUom}
                                      </div>
                                    )}
                                  </>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              </section>
            ))}
          </div>
          {pages > 1 && (
            <div className="pager">
              <span className="muted small num">
                Halaman {page} dari {pages}
              </span>
              <span className="grow" />
              <button className="btn small" disabled={page <= 1 || loading} onClick={() => setPage(page - 1)}>
                Sebelumnya
              </button>
              <button className="btn small" disabled={page >= pages || loading} onClick={() => setPage(page + 1)}>
                Berikutnya
              </button>
            </div>
          )}
        </>
      )}
    </main>
  );
}
