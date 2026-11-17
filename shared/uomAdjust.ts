/* Stock UOM Adjustment (Ryoma, 2026-11-17): unit ratios set in the app (uom_adjustments) for items whose
   SI and PI units differ, so a sale and a purchase compare per the same base unit. An adjusted ratio wins
   over Accurate's, on the item (its units) and on each SI line (its unitRatio), in every reader of a ratio:
   Jual < Beli and the recap, the last-sale ceiling, sales history, apply-cogs, COGS history. Pure. */

import type { UnitFactor } from "./types.js";
import { sameUom } from "./uom.js";

/** Item code -> its adjusted units. */
export type UomAdjustments = Map<string, UnitFactor[]>;

/** The item's units with the adjusted ones in place of Accurate's. */
export function mergeUnits(units: UnitFactor[], adjusted: UnitFactor[] | undefined): UnitFactor[] {
  if (!adjusted?.length) return units;
  return [...units.filter((u) => !adjusted.some((a) => sameUom(a.uom, u.uom))), ...adjusted];
}

/** Base units in one `unit` on an SI line: the adjusted ratio when there is one, else Accurate's. */
export function lineRatio(adj: UomAdjustments, code: string, unit: string, accurateRatio: number): number {
  return adj.get(code)?.find((a) => sameUom(a.uom, unit))?.factor ?? accurateRatio;
}
