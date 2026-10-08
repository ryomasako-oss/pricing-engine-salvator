/* "Perlu diperbaiki" (shared/fixTasks.ts): what didn't make it into an
   offer, oldest first, until someone fixes it and says what they did. */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "../context/AuthContext";
import { useToast } from "../context/ToastContext";
import { Icon } from "../components/Icon";
import { Modal } from "../components/Modal";
import { fmtDateTime, grp } from "@shared/format";
import { FIX_KINDS, ageDays, type FixKind } from "@shared/fixTasks";

interface TaskRow {
  id: number;
  kind: FixKind;
  quote_id: number | null;
  item_name: string;
  code: string;
  qty: number;
  uom: string;
  detail: string;
  created_at: string;
  resolved_at: string | null;
  resolution: string;
  quote_number: string | null;
  quote_title: string | null;
  client_name: string | null;
  created_by_name: string | null;
  resolved_by_name: string | null;
}

const KIND_BADGE: Record<FixKind, string> = {
  not_in_catalog: "red",
  cogs_held: "amber",
  unit_unknown: "amber",
  sales_rejected: "blue",
  accurate_check: "blue",
};

export function FixTasksPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const { can } = useAuth();
  const [status, setStatus] = useState<"open" | "done">("open");
  const [kind, setKind] = useState<FixKind | "all">("all");
  const [rows, setRows] = useState<TaskRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [resolving, setResolving] = useState<TaskRow | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    api
      .get<{ tasks: TaskRow[] }>(`/fix-tasks?status=${status}`)
      .then((r) => setRows(r.tasks))
      .catch((e) => toast(e.message, "error"))
      .finally(() => setLoading(false));
  }, [status, toast]);
  useEffect(load, [load]);

  const counts = useMemo(() => {
    const m = new Map<FixKind, number>();
    for (const r of rows) m.set(r.kind, (m.get(r.kind) ?? 0) + 1);
    return m;
  }, [rows]);
  const shown = kind === "all" ? rows : rows.filter((r) => r.kind === kind);
  const now = new Date();

  const resolve = async () => {
    if (!resolving) return;
    setBusy(true);
    try {
      await api.post(`/fix-tasks/${resolving.id}/resolve`, { note });
      toast("Ditandai selesai.", "success");
      setResolving(null);
      setNote("");
      load();
      window.dispatchEvent(new Event("fix-tasks-changed"));
    } catch (e) {
      toast(e instanceof Error ? e.message : "Gagal.", "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="hk-main">
      <div className="hk-page-head">
        <div>
          <h1>Perlu diperbaiki</h1>
          <p>
            Item yang tidak ikut penawaran: tidak ada di katalog, COGS perlu dicek, satuan belum ada rasionya, atau
            harganya ditolak sales. Penawaran ke klien tetap jalan tanpa item ini; bereskan di sini supaya bisa ditawarkan
            susulan. Pengingat dikirim ke manajer dan admin setiap pagi.
          </p>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <div className="tabs">
            {([
              ["open", "Terbuka"],
              ["done", "Selesai"],
            ] as const).map(([key, label]) => (
              <button key={key} className={status === key ? "on" : ""} onClick={() => setStatus(key)}>
                {label}
              </button>
            ))}
          </div>
          <button className="link-btn" onClick={load}>Muat ulang</button>
        </div>
        <div className="card-body">
          <div className="chips" style={{ marginTop: 0, marginBottom: 12 }}>
            <button className={`chip ${kind === "all" ? "on" : ""}`} onClick={() => setKind("all")}>
              Semua ({rows.length})
            </button>
            {(Object.keys(FIX_KINDS) as FixKind[]).map((k) => (
              <button key={k} className={`chip ${kind === k ? "on" : ""}`} onClick={() => setKind(k)}>
                {FIX_KINDS[k].label} ({counts.get(k) ?? 0})
              </button>
            ))}
          </div>

          {loading ? (
            <div className="loading"><span className="dots"><i /><i /><i /></span> Memuat…</div>
          ) : shown.length === 0 ? (
            <div className="empty">
              <Icon name="check" size={28} />
              <h3>{status === "open" ? "Tidak ada yang perlu diperbaiki" : "Belum ada yang diselesaikan"}</h3>
              <p>{status === "open" ? "Semua item dari list klien sudah bisa ditawarkan." : ""}</p>
            </div>
          ) : (
            <ul className="list fix-list" style={{ gap: 10 }}>
              {shown.map((r) => {
                const age = ageDays(r.created_at, now);
                return (
                  <li key={r.id} className="fix-row">
                    <div className="fix-main">
                      <div className="row-wrap" style={{ gap: 6 }}>
                        <span className={`badge ${KIND_BADGE[r.kind]}`}>{FIX_KINDS[r.kind].label}</span>
                        {status === "open" && (
                          <span className={`badge ${age >= 3 ? "red" : "grey"}`}>{age === 0 ? "hari ini" : `${age} hari`}</span>
                        )}
                      </div>
                      <strong className="fix-item">
                        {r.item_name}
                        {r.qty ? <span className="muted"> · {grp(r.qty)} {r.uom}</span> : null}
                      </strong>
                      <div className="muted small">
                        {r.code && <>{r.code} · </>}
                        {r.quote_number ?? "—"}
                        {r.client_name && <> · {r.client_name}</>}
                        {r.created_by_name && <> · dicatat {r.created_by_name}</>}
                      </div>
                      <div className="small">{r.detail}</div>
                      {status === "open" ? (
                        <div className="muted small">{FIX_KINDS[r.kind].todo}</div>
                      ) : (
                        <div className="small">
                          <Icon name="check" size={12} /> {r.resolved_by_name}, {r.resolved_at && fmtDateTime(r.resolved_at)}:{" "}
                          <em>{r.resolution}</em>
                        </div>
                      )}
                    </div>
                    <div className="fix-actions">
                      {r.quote_id && (
                        <button className="btn small ghost" onClick={() => navigate(`/quotes/${r.quote_id}`)}>
                          Buka quotation
                        </button>
                      )}
                      {status === "open" && can(FIX_KINDS[r.kind].permission) && (
                        <button className="btn small primary" onClick={() => setResolving(r)}>
                          Tandai selesai
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      {resolving && (
        <Modal
          title="Tandai selesai"
          sub={`${resolving.item_name} · ${FIX_KINDS[resolving.kind].label}`}
          onClose={() => setResolving(null)}
          footer={
            <>
              <button className="btn ghost" onClick={() => setResolving(null)}>Batal</button>
              <button className="btn primary" onClick={() => void resolve()} disabled={busy || note.trim().length < 3}>
                {busy ? "Menyimpan…" : "Selesai"}
              </button>
            </>
          }
        >
          <label className="field">
            <span>Apa yang sudah diperbaiki?</span>
            <textarea
              className="textarea"
              rows={3}
              autoFocus
              placeholder="mis. Ditambahkan ke katalog sebagai KRS-01; susulan dikirim di Q-2610/014"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
        </Modal>
      )}
    </main>
  );
}
