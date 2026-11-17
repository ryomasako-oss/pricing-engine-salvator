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
