/* Stock UOM Adjustment (Ryoma, 2026-11-17): "UOM yang tertera di SI apakah sama persis dengan UOM yang ada
   di P.I; jika terjadi perbedaan harus di-highlight … untuk bisa nanti dibereskan".
   Every SI line against the PI that "Jual < Beli" uses for it (the last one on or before the SI date),
   whatever the price, so the list holds lines sold above cost too. A difference with both ratios known
   still compares correctly; one without a ratio is where a price can be wrong by a pack size, so
   those come first. Units compare like everywhere else in the app (sameUom: case and spaces ignored).

   Pure: the same inputs as findBelowCost (server/worker/accurate/sales.ts). */

import { newestFirst, type ReceiptLine } from "./lastPurchaseCost.js";
import { netPerBaseUnit, type CatalogFacts, type SalesLine } from "./salesBelowCost.js";
import { sameUom, unitFactor } from "./uom.js";

export interface UomDiffRow {
  invoiceNo: string;
  transDate: string;
  customerName: string;
  code: string;
  name: string;
  baseUom: string;
  siUnit: string;
  /** Base units in one SI unit; null when Accurate has no ratio for it. */
  siRatio: number | null;
  piUnit: string;
  piRatio: number | null;
  receiptNo: string;
  receiptDate: string;
  /** Head to head per base unit, before PPN (as on Jual < Beli); null while a ratio is missing. */
  net: number | null;
  cost: number | null;
}

export const ratioKnown = (r: UomDiffRow) => r.siRatio !== null && r.piRatio !== null;

export function findUomDiff(
  sales: SalesLine[],
  receiptsByItem: Map<string, ReceiptLine[]>,
  catalog: Map<string, CatalogFacts>,
): UomDiffRow[] {
  const out: UomDiffRow[] = [];
  for (const l of sales) {
    const item = catalog.get(l.itemCode);
    if (!item || !(l.quantity > 0)) continue;
    const pi = (receiptsByItem.get(l.itemCode) ?? [])
      .filter((r) => r.transDate <= l.transDate && r.unitPrice > 0 && r.quantity > 0)
      .sort(newestFirst)[0];
    if (!pi || sameUom(l.unit, pi.unit)) continue;
    // The item's ratio (Accurate's or a Stock UOM Adjustment), else the line's; Accurate sends 1 when it has none.
    const siRatio = unitFactor(item, l.unit) ?? (l.unitRatio > 1 ? l.unitRatio : null);
    const piRatio = (pi.unit.trim() && unitFactor(item, pi.unit)) || null;
    const net = siRatio === null ? null : netPerBaseUnit(l);
    out.push({
      invoiceNo: l.invoiceNo, transDate: l.transDate, customerName: l.customerName, code: l.itemCode, name: item.name,
      baseUom: item.baseUom, siUnit: l.unit, siRatio, piUnit: pi.unit, piRatio,
      receiptNo: pi.receiptNo, receiptDate: pi.transDate,
      net: net === null ? null : Math.round(net * 100) / 100,
      cost: piRatio === null ? null : Math.round((pi.unitPrice / piRatio) * 100) / 100,
    });
  }
  return out.sort((a, b) => Number(ratioKnown(a)) - Number(ratioKnown(b)) || b.transDate.localeCompare(a.transDate) || a.code.localeCompare(b.code));
}

/** One item and unit pair (Ryoma, 17 Nov: "mass update jadi lebih gampang"): one ratio fixes all its SI lines. */
export interface UomDiffGroup {
  key: string;
  /** The newest SI line of the group: its units, ratios and prices stand for the group. */
  latest: UomDiffRow;
  rows: UomDiffRow[];
  /** SI lines sold under the PI price per base unit. */
  below: number;
}

const isBelow = (r: UomDiffRow) => r.net !== null && r.cost !== null && r.net < r.cost;

/** Groups by item, SI unit and PI unit: missing ratio first, then most lines under cost, then most lines. */
export function groupUomDiff(rows: UomDiffRow[]): UomDiffGroup[] {
  const groups = new Map<string, UomDiffGroup>();
  for (const r of rows) {
    const key = `${r.code}|${r.siUnit.trim().toLowerCase()}|${r.piUnit.trim().toLowerCase()}`;
    const g = groups.get(key);
    if (!g) groups.set(key, { key, latest: r, rows: [r], below: Number(isBelow(r)) });
    else {
      g.rows.push(r);
      g.below += Number(isBelow(r));
      if (r.transDate > g.latest.transDate) g.latest = r;
    }
  }
  return [...groups.values()].sort(
    (a, b) =>
      Number(ratioKnown(a.latest)) - Number(ratioKnown(b.latest)) || b.below - a.below || b.rows.length - a.rows.length || a.key.localeCompare(b.key),
  );
}
