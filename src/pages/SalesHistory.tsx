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
    <main className="hk-main">
      <div className="hk-page-head">
        <div>
          <Link to="/pencocokan" className="link-btn small">
            <Icon name="back" size={12} /> Kembali ke Pencocokan
          </Link>
          <h1>Riwayat penjualan (SI)</h1>
          <p>
            Faktur penjualan (SI) Accurate terbaru tiap barang: ke siapa, ditulis sebagai apa, dan harganya. Cari pakai kode,
            nama katalog, tulisan klien, atau nama customer untuk mengecek pencocokan. Harga setelah diskon, sebelum PPN.
          </p>
        </div>
        <Link className="btn small ghost" to="/cogs-history">
          <Icon name="search" size={13} /> Riwayat COGS
        </Link>
      </div>

      <div className="card">
        <div className="card-body">
          <div className="row-wrap" style={{ marginBottom: 12 }}>
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Cari kode, nama barang, tulisan di faktur, atau customer"
              aria-label="Cari riwayat penjualan"
              style={{ flex: 1, minWidth: 200 }}
            />
          </div>

          {loading && !data ? (
            <div className="loading"><span className="dots"><i /><i /><i /></span> Memuat…</div>
          ) : !data || data.cards.length === 0 ? (
            <div className="empty">
              <Icon name="search" size={28} />
              <h3>Tidak ada penjualan yang cocok</h3>
            </div>
          ) : (
            <>
              <div className="muted small" style={{ marginBottom: 8 }}>
                {grp(data.total)} barang · halaman {page} dari {pages}
              </div>
              <ul className="list" style={{ gap: 10, opacity: loading ? 0.6 : 1 }}>
                {data.cards.map((c) => (
                  <li key={c.code} className="card" style={{ padding: 12 }}>
                    <div>
                      <strong>{c.name}</strong>
                      <div className="muted small">{c.code} · per {c.uom}</div>
                    </div>

                    {c.names.length > 0 && (
                      <div className="small" style={{ marginTop: 8 }}>
                        <strong>Ditulis di faktur sebagai</strong>
                        <div className="row-wrap" style={{ gap: 4, marginTop: 4 }}>
                          {c.names.map((n) => (
                            <span key={n.name} className="badge grey">
                              {n.name} <span className="muted">×{grp(n.count)}</span>
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    <div className="small" style={{ marginTop: 8 }}>
                      <strong>Faktur terbaru</strong>
                      <ul className="list" style={{ gap: 2 }}>
                        {c.sales.map((s, i) => (
                          <li key={s.invoiceNo + i}>
                            {fmtDate(s.transDate)} · {s.invoiceNo} · {s.customerName || "—"} · {grp(s.quantity)} {s.unit}
                            {s.price === null ? (
                              <span className="muted"> · diretur semua</span>
                            ) : (
                              <>
                                {" "}· {rp(s.price)} / {s.unit || c.baseUom}
                                {s.unit && s.unit.toLowerCase() !== c.baseUom.toLowerCase() && (
                                  <span className="muted"> ({rp(s.perBase!)} / {c.baseUom})</span>
                                )}
                              </>
                            )}
                            {s.detailName && <div className="muted">“{s.detailName}”</div>}
                          </li>
                        ))}
                      </ul>
                    </div>
                  </li>
                ))}
              </ul>
              <div className="row-wrap" style={{ marginTop: 12, justifyContent: "center" }}>
                <button className="btn small ghost" disabled={page <= 1 || loading} onClick={() => setPage(page - 1)}>
                  Sebelumnya
                </button>
                <button className="btn small ghost" disabled={page >= pages || loading} onClick={() => setPage(page + 1)}>
                  Berikutnya
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </main>
  );
}
