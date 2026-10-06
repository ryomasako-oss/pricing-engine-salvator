/* Internal "why is each price what it is" view. Names COGS, landed cost and
   margin, so it lives only in the editor and never in the client document. */

import { useMemo, useState } from "react";
import { explainQuote } from "@shared/breakdown";
import { grp, pct } from "@shared/format";
import type { Assumptions, EngineResult, PolicyBreach, PricingPolicy, ScenarioIndex } from "@shared/types";

export function Breakdown({
  engine,
  scenario,
  assumptions,
  policy,
  breaches,
}: {
  engine: EngineResult;
  scenario: ScenarioIndex;
  assumptions: Assumptions;
  policy: PricingPolicy | null;
  breaches: PolicyBreach[];
}) {
  const b = useMemo(
    () => explainQuote(engine, scenario, assumptions, policy ?? undefined, breaches),
    [engine, scenario, assumptions, policy, breaches],
  );
  const [onlyFlagged, setOnlyFlagged] = useState(false);
  const flagged = b.lines.filter((l) => l.flags.length).length;
  const lines = onlyFlagged ? b.lines.filter((l) => l.flags.length) : b.lines;

  if (!engine.rows.length) {
    return <p className="muted">Belum ada item. Tambahkan item dulu, penjelasannya muncul di sini.</p>;
  }

  return (
    <div className="col" style={{ gap: 14 }}>
      <p className="notice info">
        Khusus internal: berisi COGS dan margin, tidak ikut ke dokumen klien. Mengikuti skenario yang sedang dipakai.
      </p>
      <div>
        <h3 style={{ margin: "0 0 6px", fontSize: 15 }}>{b.headline}</h3>
        <ul className="breakdown-points">
          {b.points.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      </div>

      <div className="row-wrap" style={{ justifyContent: "space-between" }}>
        <strong style={{ fontSize: 13.5 }}>Per item</strong>
        {flagged > 0 && (
          <label className="toggle">
            <input type="checkbox" checked={onlyFlagged} onChange={(e) => setOnlyFlagged(e.target.checked)} />
            <span className="small">Hanya yang perlu perhatian ({flagged})</span>
          </label>
        )}
      </div>

      <div className="col" style={{ gap: 8 }}>
        {lines.map((l) => (
          <details key={l.lineNo} className="breakdown-line" open={l.flags.length > 0}>
            <summary>
              <span className="muted num">{l.lineNo}</span>
              <span className="grow" style={{ fontWeight: 550 }}>{l.name}</span>
              {l.flags.map((f) => (
                <span key={f} className={`badge ${f === "Di bawah modal" ? "red" : "amber"}`}>{f}</span>
              ))}
              <span className="num">Rp {grp(l.price)}</span>
              <span className="num muted" style={{ minWidth: 52, textAlign: "right" }}>{pct(l.margin)}</span>
            </summary>
            <ol>
              {l.steps.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ol>
          </details>
        ))}
      </div>
    </div>
  );
}
