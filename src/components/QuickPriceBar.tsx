/* Tombol cepat harga (shared/quickPrice.ts): one scenario, from COGS or from the
   ceiling, +10% to +30%. Manager editor only: a price from a margin shows the COGS. */

import { useState } from "react";
import { SCENARIOS } from "@shared/engine";
import { QUICK_STEPS, quickPrice, type QuickBase, type QuickResult } from "@shared/quickPrice";
import type { ComputedRow, QuoteItem, ScenarioIndex } from "@shared/types";

export function QuickPriceBar(props: {
  items: QuoteItem[];
  rows: ComputedRow[];
  scenario: ScenarioIndex;
  step: number;
  onApply: (r: QuickResult, label: string) => void;
}) {
  const [scenario, setScenario] = useState<ScenarioIndex>(props.scenario);
  const [base, setBase] = useState<QuickBase>("cogs");
  return (
    <div className="row" style={{ gap: 6, flexWrap: "wrap", alignItems: "center", margin: "0 0 10px" }}>
      <span className="muted small">Naikkan harga</span>
      <select className="select" style={{ width: "auto" }} aria-label="Skenario" value={scenario} onChange={(e) => setScenario(Number(e.target.value) as ScenarioIndex)}>
        {SCENARIOS.map((s, k) => (
          <option key={k} value={k}>
            S{k + 1} {s.name}
          </option>
        ))}
      </select>
      <select className="select" style={{ width: "auto" }} aria-label="Dasar harga" value={base} onChange={(e) => setBase(e.target.value as QuickBase)}>
        <option value="cogs">dari COGS (margin)</option>
        <option value="plafon">dari plafon (RRP)</option>
      </select>
      {QUICK_STEPS.map((p) => (
        <button
          key={p}
          className="btn small"
          onClick={() => {
            const label = `S${scenario + 1} ${base === "cogs" ? `margin ${p * 100}%` : `plafon +${p * 100}%`}`;
            props.onApply(quickPrice(props.items, props.rows, scenario, base, p, props.step), label);
          }}
        >
          +{p * 100}%
        </button>
      ))}
    </div>
  );
}
