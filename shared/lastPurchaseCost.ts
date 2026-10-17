/* COGS = harga pembelian terakhir (Ryoma, 2026-10-15).

   The cost of an item is the unit price on its most recent goods receipt
   (Penerimaan Barang, "RI" in Accurate's Mutasi tab), converted to the
   item's base unit. Not the average: the Nilai Persediaan report averages
   receipts over a period (101311: 10.657.600 and 11.005.000 became
   10.831.300), which hides a price rise and overstates the margin.

   Pure: the receipt lines come from accurate_receipt_lines, the units from
   accurate_items (Accurate's unit1 + ratios). */

import type { UnitFactor } from "./types.js";
import { grp } from "./format.js";
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

/* ---------- Guard for "Terapkan" (Ryoma, 2026-10-17) ----------
   The audit of 16 Okt found receipts where a whole pack was recorded as one
   PCS (078328 tissue: 74.750 per roll, sold at 7.500). "Terapkan" wrote those
   into the catalog, and an item whose COGS was 0 took the wrong value as its
   reference too, so it would never look like a jump again. A change this far
   off is held back instead: the catalog keeps its COGS, the manager sees why,
   and fixes the receipt in Accurate or sets the COGS by hand. */

/** A new COGS more than this many times the current one, or less than 1/HOLD_RATIO of it, is held. */
export const HOLD_RATIO = 2;
/**
 * A purchase price this many times the selling price is held. Not every price above list: a real cost
 * above a stale selling price (101311 keset: 11.005.000 vs 8.250.000) must land, so cogsCheck blocks
 * the quote line ("COGS lebih tinggi dari harga jual") instead of the catalog keeping a cost that is too
 * low. All 10 pack-as-PCS receipts in the 16 Okt audit were at 3x list or more.
 */
export const LIST_HOLD_RATIO = 3;

/** Why a purchase-price change must not be applied automatically, or null when it may be. */
export function purchaseCostHold(from: number, to: number, listPrice: number): string | null {
  const list = Number(listPrice) || 0;
  if (list > 0 && to >= LIST_HOLD_RATIO * list) {
    return `Harga beli Rp ${grp(to)} ${LIST_HOLD_RATIO}x lipat atau lebih dari harga jual katalog Rp ${grp(list)}`;
  }
  const cur = Number(from) || 0;
  if (cur > 0 && (to > HOLD_RATIO * cur || to * HOLD_RATIO < cur)) {
    return `Harga beli Rp ${grp(to)} ${to > cur ? "lebih dari dua kali" : "kurang dari separuh"} COGS sekarang Rp ${grp(cur)}`;
  }
  return null;
}
