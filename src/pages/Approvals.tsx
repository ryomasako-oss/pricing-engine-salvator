import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { LoadError } from "../components/LoadError";
import { useToast } from "../context/ToastContext";
import { BreachList } from "../components/pricing";
import { fmtDateTime, grp, pct, rp } from "@shared/format";
import type { PolicyBreach } from "@shared/types";

interface ApprovalRow {
  id: number;
  quote_id: number;
  quote_number: string;
  quote_title: string;
  quote_status: string;
  client_name: string | null;
  decision: "pending" | "approved" | "rejected";
  note: string | null;
  requested_at: string;
  decided_at: string | null;
  requested_by_name: string;
  decided_by_name: string | null;
  breaches: PolicyBreach[];
  monthly_value: number;
  net_margin: number;
}

type Decision = ApprovalRow["decision"];
type Filter = Decision | "all";

const TABS: [Filter, string][] = [
  ["pending", "Menunggu"],
  ["approved", "Disetujui"],
  ["rejected", "Ditolak"],
  ["all", "Semua"],
];
const BADGE: Record<Decision, [string, string]> = {
  pending: ["amber", "Menunggu"],
  approved: ["green", "Disetujui"],
  rejected: ["red", "Ditolak"],
};
/** The list endpoint returns at most this many rows (server/worker/routes/approvals.ts). */
const CAP = 200;

/** Days since a SQLite UTC timestamp ("2026-11-08 02:00:00"), with fractions. */
const daysSince = (at: string, now: number) =>
  Math.max(0, (now - Date.parse(at.includes("T") ? at : `${at.replace(" ", "T")}Z`)) / 86_400_000);

export function ApprovalsPage() {
  const navigate = useNavigate();
  const toast = useToast();
  // Each decision is fetched on its own (the server returns the newest 200 per
  // call), so no tab loses history to another; "Semua" merges them.
  const [lists, setLists] = useState<Record<Decision, ApprovalRow[]>>({ pending: [], approved: [], rejected: [] });
  const [filter, setFilter] = useState<Filter>("pending");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setLoadError(null);
    const get = (d: Decision) => api.get<{ approvals: ApprovalRow[] }>(`/approvals?decision=${d}`).then((r) => r.approvals);
    Promise.all([get("pending"), get("approved"), get("rejected")])
      .then(([pending, approved, rejected]) => setLists({ pending, approved, rejected }))
      .catch((e) => setLoadError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [toast]);

  useEffect(load, [load]);

  const now = Date.now();
  const { pending } = lists;
  const all = [...lists.pending, ...lists.approved, ...lists.rejected].sort((x, y) => y.id - x.id);
  const rows = filter === "all" ? all : lists[filter];
  // A list at the cap may hold more on the server: say so with "+".
  const capped = (d: Decision) => lists[d].length >= CAP;
  const count = (f: Filter) =>
    f === "all"
      ? `${grp(all.length)}${(["pending", "approved", "rejected"] as const).some(capped) ? "+" : ""}`
      : `${grp(lists[f].length)}${capped(f) ? "+" : ""}`;
  const heldValue = pending.reduce((s, r) => s + r.monthly_value, 0);
  const avgWait = pending.length ? pending.reduce((s, r) => s + daysSince(r.requested_at, now), 0) / pending.length : 0;
  const recent = (r: ApprovalRow) => !!r.decided_at && daysSince(r.decided_at, now) < 7;
  const decidedWeek = lists.approved.filter(recent).length + lists.rejected.filter(recent).length;
  // The server orders by request, not decision, so any capped list may hide a recent decision.
  const weekCapped = capped("approved") || capped("rejected");

  return (
    <main className="hk-main page-stack">
      <div className="hk-page-head">
        <div>
          <h1>Persetujuan harga</h1>
          <p>Quotation yang melanggar kebijakan tertahan di sini sampai manajer memutuskan.</p>
        </div>
        <button className="btn ghost" onClick={load} disabled={loading}>
          Muat ulang
        </button>
      </div>

      {!loading && (
        <div className="kpi-grid">
          <div className={`kpi${pending.length ? " tone-warn" : ""}`}>
            <div className="label">Nilai tertahan / bulan</div>
            <div className="value num">{rp(heldValue)}</div>
            <div className="foot">
              {capped("pending") ? `${grp(CAP)}+ quotation menunggu; nilai dari ${grp(CAP)} terbaru` : `${grp(pending.length)} quotation menunggu`}
            </div>
          </div>
          <div className="kpi">
            <div className="label">Rata-rata tunggu</div>
            <div className="value num">
              {!pending.length
                ? "–"
                : avgWait < 1
                  ? `${Math.max(1, Math.round(avgWait * 24))} jam`
                  : `${avgWait.toLocaleString("id-ID", { maximumFractionDigits: 1 })} hari`}
            </div>
            {capped("pending") && <div className="foot">Dari {grp(CAP)} pengajuan terbaru</div>}
          </div>
          <div className="kpi">
            <div className="label">Diputuskan 7 hari terakhir</div>
            <div className="value num">{grp(decidedWeek)}{weekCapped ? "+" : ""}</div>
          </div>
        </div>
      )}

      <div className="card">
        <div className="tabs card-tabs" role="group" aria-label="Filter persetujuan">
          {TABS.map(([key, label]) => (
            <button key={key} className={filter === key ? "on" : ""} aria-pressed={filter === key} onClick={() => setFilter(key)}>
              {label}
              {!loading && <span className="tab-count num">{count(key)}</span>}
            </button>
          ))}
        </div>

        {loadError ? (
          <LoadError message={loadError} onRetry={load} />
        ) : loading ? (
          <div className="card-body skeleton-list" role="status" aria-label="Memuat persetujuan…">
            {[0, 1, 2, 3].map((i) => <span key={i} className="skeleton" />)}
          </div>
        ) : rows.length === 0 ? (
          <div className="card-body empty">
            {filter === "pending" ? (
              <>
                <h3>Tidak ada yang menunggu</h3>
                <p>Semua quotation sudah diputuskan. Antrean bersih.</p>
              </>
            ) : (
              <>
                <h3>Belum ada di sini</h3>
                <p>Belum ada persetujuan dengan status ini.</p>
              </>
            )}
          </div>
        ) : (
          <ul className="approval-list">
            {rows.map((r) => (
              <li key={r.id} className="approval-row">
                <div className="approval-main">
                  <div className="approval-title">
                    <h3>{r.quote_title}</h3>
                    <span className={`badge ${BADGE[r.decision][0]}`}>{BADGE[r.decision][1]}</span>
                  </div>
                  <div className="muted num">
                    {r.quote_number} · {r.client_name ?? "tanpa klien"} · diajukan {r.requested_by_name}{" "}
                    {fmtDateTime(r.requested_at)}
                  </div>
                  <BreachList breaches={r.breaches} />
                  {r.note && (
                    <p className="muted small approval-note">
                      Catatan {r.decided_by_name}: <em>{r.note}</em>
                    </p>
                  )}
                </div>
                <div className="approval-value">
                  <strong className="num">{rp(r.monthly_value)}</strong>
                  <span className="muted small num">per bulan · net {pct(r.net_margin)}</span>
                </div>
                <button
                  className={`btn ${r.decision === "pending" ? "primary" : ""}`}
                  onClick={() => navigate(`/quotes/${r.quote_id}`)}
                >
                  {r.decision === "pending" ? "Buka dan putuskan" : "Buka quotation"}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
