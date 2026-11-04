/* Quick price buttons (Ryoma, 2026-11-04): in one scenario, raise every line
   from its COGS (to a margin) or from its ceiling (by a percentage), 10% to
   30% at most. The result goes into each line's manual price for that
   scenario, the field a person types into, so the engine and the policy stay
   as they are and the change can be undone line by line.

   - From COGS, +30% means a 30% margin: landed / (1 - 30%), as the engine's
     target margin. A ceiling the client stated caps it; a default one does not
     (QuoteItem.rrpDefault).
   - From the ceiling, +15% means ceiling x 1,15. Above a client's ceiling that
     is ABOVE_CEILING, which needs another manager's approval, as chosen. */

import { computeEngine, priceForMargin } from "./engine.js";
import type { Assumptions, ComputedRow, QuoteItem, Region, ScenarioIndex } from "./types.js";

export type QuickBase = "cogs" | "plafon";
export const QUICK_STEPS = [0.1, 0.15, 0.2, 0.25, 0.3] as const;

export interface QuickResult {
  items: QuoteItem[];
  changed: number;
  /** Stopped at the client's ceiling (base COGS). */
  capped: number;
  /** Left as they were: held, or nothing to start from (no COGS / no ceiling). */
  skipped: number;
}

export function quickPrice(
  items: QuoteItem[],
  rows: ComputedRow[],
  scenario: ScenarioIndex,
  base: QuickBase,
  pct: number,
  step: number,
): QuickResult {
  const p = Math.min(0.3, Math.max(0, pct));
  const s = Math.max(1, Number(step) || 1);
  let changed = 0;
  let capped = 0;
  let skipped = 0;
  const next = items.map((it, i) => {
    const row = rows[i];
    const rrp = Math.round(Number(it.rrp) || 0);
    if (it.held || !row) return skipped++, it;
    let price: number;
    if (base === "cogs") {
      if (!(row.landed > 0)) return skipped++, it;
      price = priceForMargin(row.landed, p, s);
      if (rrp > 0 && !it.rrpDefault && price > rrp) {
        price = rrp;
        capped++;
      }
    } else {
      if (!(rrp > 0)) return skipped++, it;
      price = Math.ceil(Number((rrp * (1 + p) / s).toFixed(9))) * s;
    }
    const manual = [...(it.manualPrice ?? [null, null, null])];
    manual[scenario] = price;
    changed++;
    return { ...it, manualPrice: manual };
  });
  return { items: next, changed, capped, skipped };
}

/* ---------- "Overall margin 30%" in S2 (Silvy, Ryoma 2026-11-04) ----------
   Cross-subsidise as S2 means: LEADER lines keep the engine's price, every
   other line on offer is priced at one shared margin m, and m is the smallest
   that brings the quote's S2 net margin to the target. A client's ceiling still
   caps a line; the rest make up for it. m is searched against computeEngine
   itself, so rounding, opex and logistics count exactly as on the quote. */

/** No line is pushed past this margin to make up for capped ones. */
export const CALIBRATE_MAX = 0.5;

export interface CalibrateResult {
  items: QuoteItem[];
  /** The shared margin applied to the non-LEADER lines. */
  margin: number;
  /** S2 net margin after the change. */
  achieved: number;
  reached: boolean;
}

export function calibrateS2(
  items: QuoteItem[],
  assumptions: Assumptions,
  regions: Region[],
  target: number,
): CalibrateResult {
  const step = assumptions.step;
  const rows = computeEngine(assumptions, items, regions).rows;
  const at = (m: number): QuoteItem[] =>
    items.map((it, i) => {
      const row = rows[i];
      if (it.held || it.role === "LEADER" || !row || !(row.landed > 0)) return it;
      const rrp = Math.round(Number(it.rrp) || 0);
      let price = priceForMargin(row.landed, m, step);
      if (rrp > 0 && !it.rrpDefault) price = Math.min(price, rrp);
      const manual = [...(it.manualPrice ?? [null, null, null])];
      manual[1] = price;
      return { ...it, manualPrice: manual };
    });
  const s2 = (list: QuoteItem[]) => computeEngine(assumptions, list, regions).scen[1].margin;
  const goal = Math.min(0.95, Math.max(0, target));
  let hi = CALIBRATE_MAX;
  if (s2(at(hi)) < goal) {
    const best = at(hi);
    return { items: best, margin: hi, achieved: s2(best), reached: false };
  }
  let lo = 0;
  for (let k = 0; k < 40 && hi - lo > 1e-5; k++) {
    const mid = (lo + hi) / 2;
    if (s2(at(mid)) >= goal) hi = mid;
    else lo = mid;
  }
  const out = at(hi);
  return { items: out, margin: hi, achieved: s2(out), reached: true };
}
