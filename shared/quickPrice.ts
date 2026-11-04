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

import { priceForMargin } from "./engine.js";
import type { ComputedRow, QuoteItem, ScenarioIndex } from "./types.js";

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
