/* Pembelajaran pencocokan (shared/matchLearning.ts): how often the matcher's
   top guess is used as it stands, which wording it keeps missing, and how many
   pairings have become rules or been penalised.

   It answers a question nothing could answer before, so the panel says plainly
   when there is too little data to read anything into the figure. */

import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { Icon } from "./Icon";
import { grp } from "@shared/format";
import { accuracyNote, type LearningReport } from "@shared/matchLearning";

const pct = (x: number) => `${Math.round(x * 100)}%`;

export function MatchLearningPanel() {
  const [r, setReport] = useState<LearningReport | null>(null);
  const [open, setOpen] = useState(false);

  const load = useCallback(() => {
    api.get<LearningReport>("/catalog/match-learning").then(setReport).catch(() => setReport(null));
  }, []);
  useEffect(load, [load]);

  if (!r) return null;
  const judged = r.accepted + r.corrected;
  const weeks = r.weeks.filter((w) => w.accepted + w.corrected > 0);
  const peak = Math.max(1, ...weeks.map((w) => w.accepted + w.corrected));

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-head">
        <h3>Pembelajaran pencocokan</h3>
        <span className="muted small">Seberapa sering tebakan teratas dipakai apa adanya, dan istilah apa yang masih sering meleset.</span>
      </div>
      <div className="card-body">
        <div className="row-wrap" style={{ gap: 8, alignItems: "center" }}>
          <span className={`badge ${r.accuracy === null ? "grey" : r.accuracy >= 0.8 ? "green" : r.accuracy >= 0.6 ? "amber" : "red"}`}>
            {r.accuracy === null ? "belum ada data" : pct(r.accuracy)}
          </span>
          <span className="muted small">{accuracyNote(r)}</span>
        </div>

        <div className="row-wrap small" style={{ gap: 6, marginTop: 10 }}>
          <span className="badge green">{grp(r.accepted)} dipakai apa adanya</span>
          <span className="badge amber">{grp(r.corrected)} dibetulkan</span>
          <span className="badge grey">{grp(r.dropped)} tidak dipakai</span>
          <span className="badge blue">{grp(r.newItem)} jadi barang baru</span>
          <span className="badge grey">{grp(r.aliases)} istilah sudah dihafal</span>
          <span className="badge grey">{grp(r.rejectedPairs)} pasangan diturunkan</span>
        </div>

        {weeks.length > 1 && (
          <div style={{ marginTop: 14 }}>
            <div className="muted small" style={{ marginBottom: 6 }}>Per minggu (hijau = dipakai apa adanya)</div>
            <div className="row" style={{ gap: 6, alignItems: "flex-end", height: 72 }}>
              {weeks.map((w) => {
                const total = w.accepted + w.corrected;
                const h = Math.round((total / peak) * 64) + 4;
                const good = Math.round((w.accepted / total) * h);
                return (
                  <div key={w.week} style={{ flex: "1 1 0", minWidth: 0, textAlign: "center" }} title={`${w.week}: ${w.accepted} dipakai, ${w.corrected} dibetulkan`}>
                    <div style={{ height: h, display: "flex", flexDirection: "column", justifyContent: "flex-end" }}>
                      <div style={{ height: h - good, background: "var(--warn, #e0a33e)", borderRadius: "3px 3px 0 0" }} />
                      <div style={{ height: good, background: "var(--ok, #3a9d5d)", borderRadius: good === h ? "3px 3px 0 0" : 0 }} />
                    </div>
                    <div className="muted" style={{ fontSize: 10, marginTop: 4 }}>{w.week.slice(5)}</div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {r.topMissed.length > 0 && (
          <div style={{ marginTop: 14, borderTop: "1px solid var(--rule)", paddingTop: 10 }}>
            <button
              className="btn small ghost"
              style={{ width: "100%", justifyContent: "space-between" }}
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
            >
              <span>Istilah yang paling sering dibetulkan</span>
              <span className="badge amber">{grp(r.topMissed.length)}</span>
            </button>
            {open && (
              <div className="table-wrap" style={{ marginTop: 8 }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th className="l">Tulisan klien</th>
                      <th>Dibetulkan</th>
                      <th className="l">Tebakan sistem</th>
                      <th className="l">Dipilih sales</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.topMissed.map((m) => (
                      <tr key={m.text}>
                        <td className="l">{m.rawText}</td>
                        <td className="num">{grp(m.corrected)}</td>
                        <td className="l muted">{m.suggested ?? "—"}</td>
                        <td className="l">{m.chosen ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {judged === 0 && (
          <p className="notice info small" style={{ marginTop: 12 }}>
            <Icon name="alert" size={13} /> Angka terisi sendiri setiap kali quotation dibuat lewat <strong>Quotation → Dari list klien</strong>.
            Quotation yang dibuat langsung di editor tidak ikut terhitung.
          </p>
        )}
      </div>
    </div>
  );
}
