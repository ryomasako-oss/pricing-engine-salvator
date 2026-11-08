/* "Perlu diperbaiki" (shared/fixTasks.ts): what didn't make it into an
   offer, oldest first, until someone fixes it and says what they did. */

import { useCallback, useEffect, useMemo, useState, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { LoadError } from "../components/LoadError";
import { useAuth } from "../context/AuthContext";
import { useToast } from "../context/ToastContext";
import { useNavCounts } from "../context/NavCountsContext";
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
  unit_unknown: "purple",
  sales_rejected: "blue",
  accurate_check: "blue",
  new_item: "amber",
};

export function FixTasksPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const { can } = useAuth();
  const [status, setStatus] = useState<"open" | "done">("open");
  const [kind, setKind] = useState<FixKind | "all">("all");
  const [query, setQuery] = useState("");
  const { toFix } = useNavCounts();
  const [rows, setRows] = useState<TaskRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [resolving, setResolving] = useState<TaskRow | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  // Only the newest load may write: an older, slower request must not overwrite it.
  const loadSeq = useRef(0);
  const load = useCallback(() => {
    const seq = ++loadSeq.current;
    setLoading(true);
    setLoadError(null);
    api
      .get<{ tasks: TaskRow[] }>(`/fix-tasks?status=${status}`)
      .then((r) => {
        if (seq === loadSeq.current) setRows(r.tasks);
      })
      .catch((e) => seq === loadSeq.current && setLoadError(e instanceof Error ? e.message : String(e)))
      .finally(() => seq === loadSeq.current && setLoading(false));
  }, [status, toast]);
  useEffect(load, [load]);

  const counts = useMemo(() => {
    const m = new Map<FixKind, number>();
    for (const r of rows) m.set(r.kind, (m.get(r.kind) ?? 0) + 1);
    return m;
  }, [rows]);
  const q = query.trim().toLowerCase();
  const shown = rows.filter(
    (r) =>
      (kind === "all" || r.kind === kind) &&
      (!q || [r.item_name, r.code, r.quote_number, r.quote_title, r.client_name].some((v) => v?.toLowerCase().includes(q))),
  );
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
    <main className="hk-main page-stack">
      <div className="hk-page-head">
        <div>
          <h1>Perlu diperbaiki</h1>
          <p>
            Item yang tidak ikut penawaran: tidak ada di katalog, COGS perlu dicek, satuan belum ada rasionya, atau
            harganya ditolak sales. Penawaran ke klien tetap jalan tanpa item ini; bereskan di sini supaya bisa ditawarkan
            susulan. Pengingat dikirim ke manajer dan admin setiap pagi.
          </p>
        </div>
        <button className="btn ghost" onClick={load} disabled={loading}>
          Muat ulang
        </button>
      </div>

      <div className="card">
        <div className="tabs card-tabs" role="group" aria-label="Filter perbaikan">
          {([
            ["open", "Terbuka"],
            ["done", "Selesai"],
          ] as const).map(([key, label]) => (
            <button key={key} className={status === key ? "on" : ""} aria-pressed={status === key} onClick={() => setStatus(key)}>
              {label}
              {key === "open" && toFix != null && <span className="tab-count num">{grp(toFix)}</span>}
            </button>
          ))}
        </div>
        <div className="toolbar">
          <input
            className="input toolbar-search"
            type="search"
            placeholder="Cari barang, kode, quotation, klien"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Cari perbaikan"
          />
          {!loadError && (
          <div className="chips" role="group" aria-label="Jenis perbaikan">
            <button className={`chip ${kind === "all" ? "on" : ""}`} aria-pressed={kind === "all"} onClick={() => setKind("all")}>
              Semua ({grp(rows.length)})
            </button>
            {/* Only the kinds present here; a chosen kind stays so it can be cleared. */}
            {(Object.keys(FIX_KINDS) as FixKind[]).filter((k) => counts.has(k) || kind === k).map((k) => (
              <button key={k} className={`chip ${kind === k ? "on" : ""}`} aria-pressed={kind === k} onClick={() => setKind(k)}>
                {FIX_KINDS[k].label} ({grp(counts.get(k) ?? 0)})
              </button>
            ))}
          </div>
          )}
        </div>

        {loadError ? (
          <LoadError message={loadError} onRetry={load} />
        ) : loading ? (
          <div className="card-body skeleton-list" role="status" aria-label="Memuat perbaikan…">
            {[0, 1, 2, 3].map((i) => <span key={i} className="skeleton" />)}
          </div>
        ) : shown.length === 0 ? (
          <div className="card-body empty">
            {rows.length ? (
              <>
                <h3>Tidak ada yang cocok</h3>
                <p>Ubah kata pencarian atau pilih jenis lain.</p>
                <button className="btn" onClick={() => { setQuery(""); setKind("all"); }}>Hapus filter</button>
              </>
            ) : status === "open" ? (
              <>
                <h3>Tidak ada yang perlu diperbaiki</h3>
                <p>Semua item dari list klien sudah bisa ditawarkan.</p>
              </>
            ) : (
              <>
                <h3>Belum ada yang diselesaikan</h3>
                <p>Tugas yang ditandai selesai akan muncul di sini beserta catatannya.</p>
              </>
            )}
          </div>
        ) : (
          <ul className="fix-list">
            {shown.map((r) => {
              const age = ageDays(r.created_at, now);
              return (
                <li key={r.id} className="fix-row">
                  <div className="fix-main">
                    <div className="badge-row">
                      <span className={`badge ${KIND_BADGE[r.kind]}`}>{FIX_KINDS[r.kind].label}</span>
                      {status === "open" && (
                        <span className={`badge ${age >= 3 ? "red" : "grey"}`}>{age === 0 ? "hari ini" : `${age} hari`}</span>
                      )}
                    </div>
                    <strong className="fix-item">
                      {r.item_name}
                      {r.qty ? <span className="muted"> · {grp(r.qty)} {r.uom}</span> : null}
                    </strong>
                    {r.kind !== "accurate_check" && (
                      <div className="muted small">
                        {r.code}
                        {r.quote_id && (
                          <>
                            {r.code && " · "}
                            {r.quote_number ?? "—"}
                            {r.client_name && <> · {r.client_name}</>}
                            {r.created_by_name && <> · dicatat {r.created_by_name}</>}
                          </>
                        )}
                      </div>
                    )}
                    {r.detail && <div>{r.detail}</div>}
                    {status === "open" ? (
                      <div className="fix-todo">{FIX_KINDS[r.kind].todo}</div>
                    ) : (
                      <div className="fix-done">
                        <span>
                          {r.resolved_by_name}, {r.resolved_at && fmtDateTime(r.resolved_at)}: <em>{r.resolution}</em>
                        </span>
                      </div>
                    )}
                  </div>
                  <div className="fix-actions">
                    {r.quote_id && (
                      <button className="btn small" onClick={() => navigate(`/quotes/${r.quote_id}`)}>
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
