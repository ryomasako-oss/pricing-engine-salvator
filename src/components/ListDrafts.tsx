/* "List klien tersimpan" on the Dashboard: drafts of Dari list klien that I
   saved or that were sent to me (managers see every open one). Opening one
   reopens the review where it was left (ListToQuote with draftId). */

import { useState } from "react";
import { api } from "../api";
import { useAuth } from "../context/AuthContext";
import { useToast } from "../context/ToastContext";
import { fmtDateTime } from "@shared/format";
import type { DraftSummary } from "@shared/listDrafts";
import { Icon } from "./Icon";

export function ListDrafts({ drafts, onOpen, onChanged }: { drafts: DraftSummary[]; onOpen: (id: number) => void; onChanged: () => void }) {
  const { user, can } = useAuth();
  const toast = useToast();
  const [busy, setBusy] = useState<number | null>(null);
  // Cancelling is for the creator or a manager; the PIC sends it back instead (server/listDrafts.ts).
  const mayCancel = (d: DraftSummary) => d.created_by === user?.id || can("edit_all_quotes");

  const cancel = async (d: DraftSummary) => {
    setBusy(d.id);
    try {
      await api.del(`/list-drafts/${d.id}`);
      toast(`Draft "${d.title || "Tanpa judul"}" dibatalkan.`);
      onChanged();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Draft tidak bisa dibatalkan.", "error");
    } finally {
      setBusy(null);
    }
  };

  if (!drafts.length) return null;
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-head">
        <h3 style={{ margin: 0 }}>List klien tersimpan</h3>
        <span className="muted small">Lanjutkan pencocokan, atau selesaikan list yang dikirim ke Anda.</span>
      </div>
      <div className="table-wrap" style={{ border: 0, borderRadius: 0 }}>
        <table className="table">
          <thead>
            <tr>
              <th className="l">Judul</th>
              <th className="l">Klien</th>
              <th>Baris</th>
              <th className="l">Dari</th>
              <th className="l">PIC</th>
              <th className="l">Diubah</th>
              <th className="l" aria-label="Aksi" />
            </tr>
          </thead>
          <tbody>
            {drafts.map((d) => {
              const forMe = d.assigned_to === user?.id && d.created_by !== user?.id;
              return (
                <tr key={d.id} className="clickable" onClick={() => onOpen(d.id)}>
                  <td className="l">
                    <div style={{ fontWeight: 550 }}>
                      {d.title || <span className="muted">Tanpa judul</span>}
                      {forMe && <span className="badge amber" style={{ marginLeft: 6 }}>Untuk Anda</span>}
                    </div>
                    <div className="muted small">
                      {[d.file_name, d.assign_note && `Catatan: ${d.assign_note}`].filter(Boolean).join(" · ")}
                    </div>
                  </td>
                  <td className="l">{d.client_name ?? <span className="muted">—</span>}</td>
                  <td className="num">{d.rows}</td>
                  <td className="l muted">{d.created_by_name}</td>
                  <td className="l">{d.assigned_to_name ?? <span className="muted">—</span>}</td>
                  <td className="l muted nowrap">{fmtDateTime(d.updated_at)}</td>
                  <td className="l nowrap" onClick={(e) => e.stopPropagation()}>
                    <button className="btn small" onClick={() => onOpen(d.id)}>
                      <Icon name="file" size={13} /> Buka
                    </button>
                    {mayCancel(d) && (
                      <button
                        className="icon-btn"
                        style={{ marginLeft: 4 }}
                        title="Batalkan draft"
                        aria-label={`Batalkan draft ${d.title}`}
                        disabled={busy === d.id}
                        onClick={() => void cancel(d)}
                      >
                        <Icon name="x" size={14} />
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
