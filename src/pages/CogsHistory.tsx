/* Riwayat COGS: one card per catalog item with its recent purchase prices
   (goods receipts) and earlier COGS values. Read-only; COGS is changed in
   Katalog → "COGS dari harga pembelian terakhir". Needs view_costs. */

import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { useToast } from "../context/ToastContext";
import { Icon } from "../components/Icon";
import { fmtDate, fmtDateTime, grp, rp } from "@shared/format";

interface Card {
  code: string;
  name: string;
  uom: string;
  cogs: number;
  pending: { to: number; receiptNo: string; transDate: string; held: string | null } | null;
  receipts: { receiptNo: string; transDate: string; unit: string; quantity: number; unitPrice: number; cost: number | null; used: boolean }[];
  changes: { cogs: number; at: string }[];
}

interface Page {
  total: number;
  page: number;
  pageSize: number;
  cards: Card[];
}

export function CogsHistoryPage() {
  const toast = useToast();
  // Katalog's "Riwayat" links arrive here as /cogs-history?q=<kode>.
  const [params] = useSearchParams();
  const [q, setQ] = useState(params.get("q") ?? "");
  const [search, setSearch] = useState(params.get("q") ?? "");
  const [onlyPending, setOnlyPending] = useState(false);
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
      .get<Page>(`/accurate/cogs-history?q=${encodeURIComponent(search)}&pending=${onlyPending ? 1 : 0}&page=${page}`)
      .then((r) => live && setData(r))
      .catch((e) => live && toast(e.message, "error"))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [search, onlyPending, page, toast]);

  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <main className="hk-main page-stack">
      <div className="hk-page-head">
        <div>
          <Link to="/catalog" className="link-btn">
            <Icon name="back" size={14} /> Kembali ke Katalog
          </Link>
          <h1>Riwayat COGS</h1>
          <p>
            Harga beli terbaru dari penerimaan barang (RI) Accurate dan COGS lama tiap barang. Halaman ini hanya
            menampilkan; untuk mengubah COGS pakai "COGS dari harga pembelian terakhir" di Katalog.
          </p>
        </div>
        <Link className="btn ghost" to="/sales-history">
          Riwayat penjualan (SI)
        </Link>
      </div>

      <div className="card">
        <div className="toolbar">
          <input
            className="input toolbar-search"
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Cari kode atau nama barang"
            aria-label="Cari barang"
          />
          <label className="check">
            <input
              type="checkbox"
              checked={onlyPending}
              onChange={(e) => {
                setOnlyPending(e.target.checked);
                setPage(1);
              }}
            />
            <span>Hanya yang COGS-nya beda dari RI terakhir</span>
          </label>
          <span className="grow" />
          {data && <span className="muted small num">{grp(data.total)} barang</span>}
        </div>
      </div>

      {loading && !data ? (
        <div className="card">
          <div className="card-body skeleton-list" role="status" aria-label="Memuat riwayat COGS…">
            {[0, 1, 2, 3].map((i) => <span key={i} className="skeleton" />)}
          </div>
        </div>
      ) : !data || data.cards.length === 0 ? (
        <div className="card">
          <div className="card-body empty">
            <h3>Tidak ada barang</h3>
            <p>{search || onlyPending ? "Ubah kata pencarian atau matikan saringan." : "Belum ada riwayat harga beli dari Accurate."}</p>
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
                  <div className="row-wrap">
                    <span className="muted">COGS katalog:</span>
                    {c.cogs > 0 ? <strong className="num">{rp(c.cogs)}</strong> : <strong className="text-err">kosong</strong>}
                    {c.pending && (
                      <span className={`badge ${c.pending.held ? "amber" : "blue"}`} title={c.pending.held ?? undefined}>
                        RI terakhir {rp(c.pending.to)} · {c.pending.held ? "ditahan, perlu dicek" : "belum diterapkan"}
                      </span>
                    )}
                  </div>

                  <div className="card-section">
                    <h4 className="label-title">Harga beli (RI)</h4>
                    {c.receipts.length === 0 ? (
                      <p className="muted">Belum ada RI dalam riwayat yang tersimpan.</p>
                    ) : (
                      <div className="table-wrap">
                        <table className="table">
                          <thead>
                            <tr>
                              <th className="l">Nomor RI</th>
                              <th className="l">Tanggal</th>
                              <th>Qty</th>
                              <th>Harga / satuan</th>
                              <th className="l" aria-label="Keterangan" />
                            </tr>
                          </thead>
                          <tbody>
                            {c.receipts.map((r, i) => (
                              <tr key={r.receiptNo + i}>
                                <td className="l num nowrap">{r.receiptNo}</td>
                                <td className="l nowrap">{fmtDate(r.transDate)}</td>
                                <td className="num">{grp(r.quantity)}</td>
                                <td className="num nowrap">
                                  {rp(r.unitPrice)} <span className="muted">/ {r.unit || "satuan dasar"}</span>
                                </td>
                                <td className="l">
                                  <div className="badge-row">
                                    {i === 0 && <span className="badge blue">Terbaru</span>}
                                    {r.used && (
                                      <span className="badge green">
                                        Dipakai
                                      </span>
                                    )}
                                  </div>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                    {c.cogs > 0 && c.receipts.length > 0 && !c.receipts.some((r) => r.used) && (
                      <p className="muted small">COGS tidak cocok dengan RI mana pun di atas (mungkin manual atau dari Excel).</p>
                    )}
                  </div>

                  {c.changes.length > 0 && (
                    <div className="card-section">
                      <h4 className="label-title">COGS katalog yang pernah diganti</h4>
                      <ul className="list-stack compact">
                        {c.changes.map((h, i) => (
                          <li key={i}>
                            <span className="num">{rp(h.cogs)}</span> <span className="muted">diganti {fmtDateTime(h.at)}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
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
