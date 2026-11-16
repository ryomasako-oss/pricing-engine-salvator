/* Sales Order: daftar SO dari quotation dan posisinya di gudang FMS Salvator. */

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../api";
import { LoadError } from "../components/LoadError";
import { FulfillmentBadge, SoStatusBadge, SyncBadge } from "../components/SalesOrderBadges";
import { fmtDate, grp, rp } from "@shared/format";
import { SO_STATUS_LABEL, type FulfillmentState, type SalesOrderStatus, type SyncState } from "@shared/fmsState";

export interface SalesOrderSummary {
  id: number;
  number: string;
  quote_id: number;
  quote_number: string;
  client_name: string | null;
  status: SalesOrderStatus;
  sync_state: SyncState;
  sync_error: string | null;
  fulfillment_state: FulfillmentState | null;
  fulfillment_reason: string | null;
  total_value: number;
  created_by_name: string | null;
  created_at: string;
}

export function SalesOrdersPage() {
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [rows, setRows] = useState<SalesOrderSummary[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [disabled, setDisabled] = useState(false);
  const [retry, setRetry] = useState(0);

  // Typing waits half a second before asking the server.
  useEffect(() => {
    const t = setTimeout(() => setSearch(q.trim()), 500);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setLoadError(null);
    api
      .get<{ salesOrders: SalesOrderSummary[] }>(`/sales-orders?status=${encodeURIComponent(status)}&q=${encodeURIComponent(search)}`)
      .then((r) => live && setRows(r.salesOrders))
      .catch((e) => {
        if (!live) return;
        if (e instanceof ApiError && e.status === 403) setDisabled(true);
        else setLoadError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [status, search, retry]);

  return (
    <main className="hk-main page-stack">
      <div className="hk-page-head">
        <div>
          <h1>Sales Order</h1>
          <p>Quotation yang sudah dijadikan SO dan posisinya di gudang FMS Salvator.</p>
        </div>
      </div>

      {disabled ? (
        <div className="card">
          <div className="card-body empty">
            <h3>Sales Order belum dinyalakan</h3>
            <p>Fitur ini masih diuji. Admin menyalakannya setelah alur dengan gudang dicoba.</p>
          </div>
        </div>
      ) : (
        <>
          <div className="card">
            <div className="toolbar">
              <select className="select inline" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status SO">
                <option value="">Semua status</option>
                {(Object.keys(SO_STATUS_LABEL) as SalesOrderStatus[]).map((s) => (
                  <option key={s} value={s}>
                    {SO_STATUS_LABEL[s]}
                  </option>
                ))}
              </select>
              <input
                className="input toolbar-search"
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Cari nomor SO, quotation, klien"
                aria-label="Cari Sales Order"
              />
              <span className="grow" />
              {rows && !loadError && <span className="muted small num">{grp(rows.length)} SO</span>}
            </div>
          </div>

          {loadError ? (
            <div className="card">
              <LoadError message={loadError} onRetry={() => setRetry((r) => r + 1)} />
            </div>
          ) : loading && !rows ? (
            <div className="card">
              <div className="card-body skeleton-list" role="status" aria-label="Memuat Sales Order…">
                {[0, 1, 2, 3].map((i) => <span key={i} className="skeleton" />)}
              </div>
            </div>
          ) : !rows || rows.length === 0 ? (
            <div className="card">
              <div className="card-body empty">
                <h3>Belum ada Sales Order</h3>
                <p>{search || status ? "Ubah status atau kata pencarian." : "Buka quotation yang disetujui, lalu pilih Jadikan SO."}</p>
              </div>
            </div>
          ) : (
            <div className={`card${loading ? " is-stale" : ""}`}>
              <div className="table-wrap">
                <table className="table stack">
                  <thead>
                    <tr>
                      <th className="l">Nomor</th>
                      <th className="l">Klien</th>
                      <th className="l">Tanggal</th>
                      <th className="l">Status</th>
                      <th className="l">Posisi gudang</th>
                      <th className="l">Status kirim</th>
                      <th className="r">Nilai</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((so) => (
                      <tr key={so.id}>
                        <td className="l nowrap stack-title">
                          <Link to={`/sales-orders/${so.id}`} className="num">{so.number}</Link>
                          <div className="muted small num">{so.quote_number}</div>
                        </td>
                        <td className="l" data-label="Klien">{so.client_name ?? "—"}</td>
                        <td className="l nowrap num" data-label="Tanggal">{fmtDate(so.created_at)}</td>
                        <td className="l" data-label="Status"><SoStatusBadge status={so.status} /></td>
                        <td className="l" data-label="Posisi gudang"><FulfillmentBadge state={so.fulfillment_state} reason={so.fulfillment_reason} /></td>
                        <td className="l" data-label="Status kirim" title={so.sync_error ?? undefined}><SyncBadge state={so.sync_state} /></td>
                        <td className="r num nowrap" data-label="Nilai">{rp(so.total_value)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </main>
  );
}
