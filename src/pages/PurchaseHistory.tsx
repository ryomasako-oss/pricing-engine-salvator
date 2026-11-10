/* Riwayat pembelian (PI): one card per catalog item with its latest purchase-invoice
   lines: the price as written on the PI ("termasuk PPN" when ticked) and the modal it
   gives, after discounts and before PPN (server/worker/accurate/purchaseHistory.ts).
   Search takes a code, a name or a PI number. Read-only; needs view_costs. */

import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { useToast } from "../context/ToastContext";
import { LoadError } from "../components/LoadError";
import { HistoryTabs } from "../components/HistoryTabs";
import { fmtDate, grp, rp } from "@shared/format";

interface Card {
  code: string;
  name: string;
  uom: string;
  purchases: {
    invoiceNo: string;
    transDate: string;
    unit: string;
    quantity: number;
    invoicePrice: number;
    price: number;
    inclusiveTax: boolean;
  }[];
}

interface Page {
  total: number;
  page: number;
  pageSize: number;
  cards: Card[];
}

export function PurchaseHistoryPage() {
  const toast = useToast();
  // A link can arrive as /purchase-history?q=<kode>.
  const [params] = useSearchParams();
  const [q, setQ] = useState(params.get("q") ?? "");
  const [search, setSearch] = useState(params.get("q") ?? "");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Page | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);

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
    setLoadError(null);
    api
      .get<Page>(`/accurate/purchase-history?q=${encodeURIComponent(search)}&page=${page}`)
      .then((r) => live && setData(r))
      .catch((e) => live && setLoadError(e instanceof Error ? e.message : String(e)))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [search, page, toast, retry]);

  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <main className="hk-main page-stack">
      <HistoryTabs />
      <div className="hk-page-head">
        <div>
          <h1>Riwayat pembelian (PI)</h1>
          <p>
            Faktur pembelian (PI) Accurate terbaru tiap barang: harga seperti tertulis di faktur, dan modal yang dihasilkan
            setelah diskon dan sebelum PPN. Faktur yang dicentang "Total termasuk pajak" ditandai. Cari pakai kode, nama
            barang, atau nomor PI.
          </p>
        </div>
      </div>

      <div className="card">
        <div className="toolbar">
          <input
            className="input toolbar-search wide"
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Cari kode, nama barang, atau nomor PI"
            aria-label="Cari riwayat pembelian"
          />
          <span className="grow" />
          {data && !loadError && <span className="muted small num">{grp(data.total)} barang dibeli</span>}
        </div>
      </div>

      {loadError ? (
        <div className="card">
          <LoadError message={loadError} onRetry={() => setRetry((r) => r + 1)} />
        </div>
      ) : loading && !data ? (
        <div className="card">
          <div className="card-body skeleton-list" role="status" aria-label="Memuat riwayat pembelian…">
            {[0, 1, 2, 3].map((i) => <span key={i} className="skeleton" />)}
          </div>
        </div>
      ) : !data || data.cards.length === 0 ? (
        <div className="card">
          <div className="card-body empty">
            <h3>Tidak ada pembelian yang cocok</h3>
            <p>{search ? "Coba kode barang, sebagian nama, atau nomor PI." : "Belum ada faktur pembelian dari Accurate."}</p>
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
                  <div className="card-section">
                    <h4 className="label-title">Faktur pembelian terbaru</h4>
                    <div className="table-wrap">
                      <table className="table stack">
                        <thead>
                          <tr>
                            <th className="l">Nomor PI</th>
                            <th className="l">Tanggal</th>
                            <th>Qty</th>
                            <th>Harga di faktur</th>
                            <th>Modal (sebelum PPN)</th>
                          </tr>
                        </thead>
                        <tbody>
                          {c.purchases.map((p, i) => (
                            <tr key={p.invoiceNo + i}>
                              <td className="l num nowrap stack-title">{p.invoiceNo}</td>
                              <td className="l nowrap" data-label="Tanggal">{fmtDate(p.transDate)}</td>
                              <td className="num nowrap" data-label="Qty">
                                <span>{grp(p.quantity)} {p.unit}</span>
                              </td>
                              <td className="num nowrap" data-label="Harga di faktur">
                                <div>
                                  {rp(p.invoicePrice)} / {p.unit || c.uom}
                                  {p.inclusiveTax && <div className="muted small">termasuk PPN</div>}
                                  {p.price === 0 && p.invoicePrice > 0 && <span className="badge grey">Bonus (gratis)</span>}
                                </div>
                              </td>
                              <td className="num nowrap" data-label="Modal (sebelum PPN)">
                                <span>
                                  <strong>{rp(p.price)}</strong> / {p.unit || c.uom}
                                </span>
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
