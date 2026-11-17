/* Loads Stock UOM Adjustment ratios (shared/uomAdjust.ts) for one entity. The table holds a handful of
   rows (one per item and unit fixed by hand), so it is read whole. */

import { all } from "../../db.d1";
import type { UomAdjustments } from "../../../shared/uomAdjust";
import type { EntityKey } from "./sync";

export async function loadUomAdjustments(db: D1Database, entity: EntityKey): Promise<UomAdjustments> {
  const out: UomAdjustments = new Map();
  for (const r of await all<{ code: string; uom: string; factor: number }>(db, "SELECT code, uom, factor FROM uom_adjustments WHERE entity = ?1", entity)) {
    const list = out.get(r.code);
    if (list) list.push({ uom: r.uom, factor: r.factor });
    else out.set(r.code, [{ uom: r.uom, factor: r.factor }]);
  }
  return out;
}
