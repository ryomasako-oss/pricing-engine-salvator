/* Riwayat Audit: who did what and when, from audit_log (read-only; the log cannot be changed).
   Filter by date (WIB), kind of data and text; Export Excel takes every matching row. Needs view_audit. */

import { useEffect, useState } from "react";
import { api } from "../api";
import { useToast } from "../context/ToastContext";
import { HistoryTabs } from "../components/HistoryTabs";
import { LoadError } from "../components/LoadError";
import { fmtDateTime, grp } from "@shared/format";
import { AUDIT_ENTITIES, auditActionLabel, auditDetailText, auditEntityLabel } from "@shared/auditLog";
import type { AuditEntry } from "@shared/types";

interface Page {
  total: number;
  page: number;
  pageSize: number;
  entries: AuditEntry[];
}

const iso = (d: Date) => new Date(d.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);

export function AuditLogPage() {
  const toast = useToast();
  const [to, setTo] = useState(() => iso(new Date()));
  const [from, setFrom] = useState(() => iso(new Date(Date.now() - 30 * 86_400_000)));
  const [entity, setEntity] = useState("");
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Page | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [exporting, setExporting] = useState(false);

  // Typing waits half a second before asking the server.
  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(q);
      setPage(1);
    }, 500);
    return () => clearTimeout(t);
  }, [q]);

  const query = `from=${from}&to=${to}&entity=${encodeURIComponent(entity)}&q=${encodeURIComponent(search)}`;

  useEffect(() => {
    if (!from || !to) return;
    let live = true;
    setLoading(true);
    setLoadError(null);
    api
      .get<Page>(`/approvals/audit?${query}&page=${page}`)
      .then((r) => live && setData(r))
      .catch((e) => live && setLoadError(e instanceof Error ? e.message : String(e)))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [query, page, retry]);

  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  async function exportExcel() {
    setExporting(true);
    try {
      const r = await api.get<Page>(`/approvals/audit?${query}&all=1`);
      (await import("../export/auditLog")).exportAudit(r.entries, from, to);
      if (r.total > r.entries.length) toast(`Hanya ${grp(r.entries.length)} dari ${grp(r.total)} baris yang diekspor. Persempit rentang tanggal.`, "error");
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setExporting(false);
    }
  }

  return (
    <main className="hk-main page-stack">
      <HistoryTabs />
      <div className="hk-page-head">
        <div>
          <h1>Riwayat Audit</h1>
          <p>
            Catatan siapa melakukan apa dan kapan: quotation, persetujuan, katalog, COGS, pengguna, pengaturan. Catatan ini tidak bisa diubah atau dihapus.
          </p>
        </div>
      </div>

      <div className="card">
        <div className="toolbar">
          <label className="row">
            <span className="muted small">Dari</span>
            <input className="input" type="date" value={from} max={to} onChange={(e) => { setFrom(e.target.value); setPage(1); }} aria-label="Tanggal dari" />
          </label>
          <label className="row">
            <span className="muted small">Sampai</span>
            <input className="input" type="date" value={to} min={from} onChange={(e) => { setTo(e.target.value); setPage(1); }} aria-label="Tanggal sampai" />
          </label>
          <select className="select inline" value={entity} onChange={(e) => { setEntity(e.target.value); setPage(1); }} aria-label="Jenis data">
            <option value="">Semua data</option>
            {Object.entries(AUDIT_ENTITIES).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
          <input
            className="input toolbar-search"
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Cari nama, kode barang, nomor, aksi"
            aria-label="Cari di riwayat audit"
          />
          <span className="grow" />
          {data && !loadError && <span className="muted small num">{grp(data.total)} catatan</span>}
          <button className="btn" disabled={!data?.total || exporting} onClick={exportExcel}>
            {exporting ? "Menyiapkan…" : "Export Excel"}
          </button>
        </div>
      </div>

      {loadError ? (
        <div className="card">
          <LoadError message={loadError} onRetry={() => setRetry((r) => r + 1)} />
        </div>
      ) : loading && !data ? (
        <div className="card">
          <div className="card-body skeleton-list" role="status" aria-label="Memuat riwayat audit…">
            {[0, 1, 2, 3].map((i) => <span key={i} className="skeleton" />)}
          </div>
        </div>
      ) : !data || data.entries.length === 0 ? (
        <div className="card">
          <div className="card-body empty">
            <h3>Tidak ada catatan</h3>
            <p>Ubah rentang tanggal, jenis data, atau kata pencarian.</p>
          </div>
        </div>
      ) : (
        <div className={`card${loading ? " is-stale" : ""}`}>
          <div className="table-wrap">
            <table className="table stack">
              <thead>
                <tr>
                  <th className="l">Waktu</th>
                  <th className="l">Oleh</th>
                  <th className="l">Data</th>
                  <th className="l">Aksi</th>
                  <th className="l">Keterangan</th>
                </tr>
              </thead>
              <tbody>
                {data.entries.map((e) => (
                  <tr key={e.id}>
                    <td className="l nowrap stack-title">{fmtDateTime(e.created_at)}</td>
                    <td className="l" data-label="Oleh">{e.actor_name}</td>
                    <td className="l nowrap" data-label="Data">
                      {auditEntityLabel(e.entity)}
                      {e.entity_id ? <span className="muted"> #{e.entity_id}</span> : null}
                    </td>
                    <td className="l" data-label="Aksi">
                      <span className={`badge ${e.action === "login_failed" || e.action === "deleted" || e.action === "cleared" ? "amber" : "grey"}`}>
                        {auditActionLabel(e.action)}
                      </span>
                    </td>
                    <td className="l small" data-label="Keterangan" title={e.detail}>
                      {auditDetailText(e.detail)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
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
        </div>
      )}
    </main>
  );
}
