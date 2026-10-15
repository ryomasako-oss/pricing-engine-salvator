/* COGS = harga pembelian terakhir (Ryoma, 2026-10-15).

   The cost of an item is the unit price on its most recent goods receipt
   (Penerimaan Barang, "RI" in Accurate's Mutasi tab), converted to the
   item's base unit. Not the average: the Nilai Persediaan report averages
   receipts over a period (101311: 10.657.600 and 11.005.000 became
   10.831.300), which hides a price rise and overstates the margin.

   Pure: the receipt lines come from accurate_receipt_lines, the units from
   accurate_items (Accurate's unit1 + ratios). */

import type { UnitFactor } from "./types.js";
import { sameUom, unitFactor } from "./uom.js";

export interface ReceiptLine {
  /** Accurate record id of the receipt; a later record has a higher id. */
  receiptId: number;
  /** Line id within the receipt (Accurate detail id, or its position). */
  lineId: number;
  receiptNo: string;
  /** Transaction date, YYYY-MM-DD. */
  transDate: string;
  unit: string;
  quantity: number;
  unitPrice: number;
}

export type PurchaseCost =
  | { ok: true; cost: number; receiptNo: string; transDate: string; unit: string }
  | { ok: false; reason: "no_receipt" }
  /** The catalog's base unit isn't Accurate's unit1, so a cost per unit1 would be per the wrong unit. */
  | { ok: false; reason: "uom_mismatch" }
  /** The latest receipt is in a unit with no known ratio. Not silently replaced by an older price. */
  | { ok: false; reason: "unknown_unit"; receiptNo: string; transDate: string; unit: string };

const round2 = (x: number) => Math.round(x * 100) / 100;

/** Latest first: date, then the later Accurate record, then the later line. Receipt numbers are not ordered. */
const newestFirst = (a: ReceiptLine, b: ReceiptLine) =>
  b.transDate.localeCompare(a.transDate) || b.receiptId - a.receiptId || b.lineId - a.lineId;

export function lastPurchaseCost(
  lines: ReceiptLine[],
  item: { baseUom: string; units: UnitFactor[] },
  catalogUom: string,
): PurchaseCost {
  const priced = lines.filter((l) => l.unitPrice > 0 && l.quantity > 0).sort(newestFirst);
  const last = priced[0];
  if (!last) return { ok: false, reason: "no_receipt" };
  if (!sameUom(catalogUom, item.baseUom)) return { ok: false, reason: "uom_mismatch" };
  const factor = last.unit.trim() ? unitFactor(item, last.unit) : undefined;
  if (!factor) {
    return { ok: false, reason: "unknown_unit", receiptNo: last.receiptNo, transDate: last.transDate, unit: last.unit };
  }
  return { ok: true, cost: round2(last.unitPrice / factor), receiptNo: last.receiptNo, transDate: last.transDate, unit: last.unit };
}
