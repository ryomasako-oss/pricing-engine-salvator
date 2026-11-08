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
    <div className="card">
      <div className="card-head">
        <h3>Pembelajaran pencocokan</h3>
        <span className="muted small">Seberapa sering tebakan teratas dipakai apa adanya, dan istilah apa yang masih sering meleset.</span>
      </div>
      <div className="card-body form-stack">
        <div className="row-wrap">
          <span className={`badge ${r.accuracy === null ? "grey" : r.accuracy >= 0.8 ? "green" : r.accuracy >= 0.6 ? "amber" : "red"}`}>
            {r.accuracy === null ? "belum ada data" : pct(r.accuracy)}
          </span>
          <span className="muted small">{accuracyNote(r)}</span>
        </div>

        <div className="badge-row">
          <span className="badge green">{grp(r.accepted)} dipakai apa adanya</span>
          <span className="badge amber">{grp(r.corrected)} dibetulkan</span>
          <span className="badge grey">{grp(r.dropped)} tidak dipakai</span>
          <span className="badge blue">{grp(r.newItem)} jadi barang baru</span>
          <span className="badge grey">{grp(r.aliases)} istilah sudah dihafal</span>
          <span className="badge grey">{grp(r.rejectedPairs)} pasangan diturunkan</span>
        </div>

        {weeks.length > 1 && (
          <div>
            <div className="spread spark-head">
              <span className="muted small">Per minggu</span>
              <span className="row-wrap">
                <span className="legend muted small">
                  <i className="spark-key good" /> dipakai apa adanya
                </span>
                <span className="legend muted small">
                  <i className="spark-key bad" /> dibetulkan
                </span>
              </span>
            </div>
            <div className="spark-bars">
              {weeks.map((w) => {
                const total = w.accepted + w.corrected;
                const good = Math.round((w.accepted / total) * 100);
                return (
                  <div
                    className="spark-col"
                    key={w.week}
                    title={`${w.week}: ${w.accepted} dipakai apa adanya, ${w.corrected} dibetulkan`}
                  >
                    {/* Height is a share of the busiest week, never of the box, so the
                        tallest bar ends exactly on the rule. */}
                    <div className="spark-bar" style={{ height: `${Math.max(6, Math.round((total / peak) * 100))}%` }}>
                      <span className="bad" style={{ height: `${100 - good}%` }} />
                      <span className="good" style={{ height: `${good}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="spark-labels">
              {weeks.map((w) => (
                <span key={w.week}>{w.week.slice(5)}</span>
              ))}
            </div>
          </div>
        )}

        {r.topMissed.length > 0 && (
          <div className="disclosure">
            <button
              className="btn small ghost disclosure-toggle"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
            >
              <span><Icon name="chevron-down" size={14} /> Istilah yang paling sering dibetulkan</span>
              <span className="badge amber">{grp(r.topMissed.length)}</span>
            </button>
            {open && (
              <div className="table-wrap">
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
          <p className="notice info"> Angka terisi sendiri setiap kali baris dibereskan di atas, atau quotation dibuat lewat{" "}
            <strong>Quotation → Dari list klien</strong>. Quotation yang dibuat langsung di editor tidak ikut terhitung.
          </p>
        )}
      </div>
    </div>
  );
}
