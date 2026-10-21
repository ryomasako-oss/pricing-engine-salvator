/* Riwayat COGS: one card per catalog item with its recent purchase prices
   (goods receipts) and earlier COGS values. Read-only; COGS is changed in
   Katalog → "COGS dari harga pembelian terakhir". Needs view_costs. */

import { useEffect, useState } from "react";
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
  receipts: { receiptNo: string; transDate: string; unit: string; quantity: number; unitPrice: number }[];
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
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
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
    <main className="hk-main">
      <div className="hk-page-head">
        <div>
          <h1>Riwayat COGS</h1>
          <p>
            Harga beli terbaru dari penerimaan barang (RI) Accurate dan COGS lama tiap barang. Halaman ini hanya
            menampilkan; untuk mengubah COGS pakai "COGS dari harga pembelian terakhir" di Katalog.
          </p>
        </div>
      </div>

      <div className="card">
        <div className="card-body">
          <div className="row-wrap" style={{ marginBottom: 12 }}>
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Cari kode atau nama barang"
              aria-label="Cari barang"
              style={{ flex: 1, minWidth: 200 }}
            />
            <label className="small row-wrap" style={{ gap: 6 }}>
              <input
                type="checkbox"
                checked={onlyPending}
                onChange={(e) => {
                  setOnlyPending(e.target.checked);
                  setPage(1);
                }}
              />
              Hanya yang COGS-nya beda dari RI terakhir
            </label>
          </div>

          {loading && !data ? (
            <div className="loading"><span className="dots"><i /><i /><i /></span> Memuat…</div>
          ) : !data || data.cards.length === 0 ? (
            <div className="empty">
              <Icon name="search" size={28} />
              <h3>Tidak ada barang</h3>
            </div>
          ) : (
            <>
              <div className="muted small" style={{ marginBottom: 8 }}>
                {grp(data.total)} barang · halaman {page} dari {pages}
              </div>
              <ul className="list" style={{ gap: 10, opacity: loading ? 0.6 : 1 }}>
                {data.cards.map((c) => (
                  <li key={c.code} className="card" style={{ padding: 12 }}>
                    <div className="row-wrap" style={{ justifyContent: "space-between" }}>
                      <div>
                        <strong>{c.name}</strong>
                        <div className="muted small">{c.code} · per {c.uom}</div>
                      </div>
                      <div style={{ textAlign: "right" }}>
                        <div>COGS katalog: <strong>{c.cogs > 0 ? rp(c.cogs) : "kosong"}</strong></div>
                        {c.pending && (
                          <span className={`badge ${c.pending.held ? "red" : "amber"}`} title={c.pending.held ?? undefined}>
                            RI terakhir {rp(c.pending.to)} · {c.pending.held ? "ditahan, perlu dicek" : "belum diterapkan"}
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="small" style={{ marginTop: 8 }}>
                      <strong>Harga beli (RI)</strong>
                      {c.receipts.length === 0 ? (
                        <div className="muted">Belum ada RI dalam riwayat yang tersimpan.</div>
                      ) : (
                        <ul className="list" style={{ gap: 2 }}>
                          {c.receipts.map((r, i) => (
                            <li key={r.receiptNo + i}>
                              {fmtDate(r.transDate)} · {r.receiptNo} · {rp(r.unitPrice)} / {r.unit || "satuan dasar"}
                              {i === 0 && <span className="muted"> · terakhir</span>}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>

                    {c.changes.length > 0 && (
                      <div className="small" style={{ marginTop: 8 }}>
                        <strong>COGS katalog yang pernah diganti</strong>
                        <ul className="list" style={{ gap: 2 }}>
                          {c.changes.map((h, i) => (
                            <li key={i}>
                              {rp(h.cogs)} <span className="muted">diganti {fmtDateTime(h.at)}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
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
