/* Dijual di bawah modal (Ryoma, 2026-11-04): a sales invoice line whose net
   price per base unit is under the purchase price of that day, for the
   morning recap (server/worker/accurateRecap.ts).

   "Modal" is the cost on the date of the invoice, not today's COGS: the last
   goods receipt on or before the invoice date (lastPurchaseCost), so a price
   rise after a sale doesn't make an old invoice look like a loss. Both sides
   are before PPN: Accurate's receipt unitPrice already is, and so is an
   invoice line's salesAmount, even on an invoice with inclusive prices
   (SI.2025.11.00014: 4 PCS at 60.000 incl. PPN has salesAmount 216.216,43 =
   240.000 / 1,11). Dividing it by 1,11 again made those lines 11% too cheap.

   Pure: the lines come from accurate_sales_lines / accurate_receipt_lines. */

import type { UnitFactor } from "./types.js";
import { LIST_HOLD_RATIO, lastPurchaseCost, type ReceiptLine } from "./lastPurchaseCost.js";

export interface SalesLine {
  invoiceNo: string;
  /** YYYY-MM-DD */
  transDate: string;
  customerName: string;
  itemCode: string;
  unit: string;
  /** Base units in one `unit`. */
  unitRatio: number;
  quantity: number;
  returnQty: number;
  /** Line total after the item discount and before PPN, as Accurate sends it, inclusive invoice or not. */
  salesAmount: number;
  inclusiveTax: boolean;
  /** PPN %, e.g. 11. */
  taxRate: number;
  /** Invoice-level discount and the sub-total it is spread over. */
  cashDiscount: number;
  subTotal: number;
}

/**
 * What the client paid per base unit, after every discount and before PPN; null when the line
 * sold nothing (no quantity, or all of it returned).
 */
export function netPerBaseUnit(l: SalesLine): number | null {
  const qty = l.quantity * (l.unitRatio > 0 ? l.unitRatio : 1);
  if (!(qty > 0) || l.returnQty >= l.quantity) return null;
  const cash = l.subTotal > 0 ? Math.min(1, Math.max(0, l.cashDiscount / l.subTotal)) : 0;
  return (l.salesAmount * (1 - cash)) / qty;
}

export interface CatalogFacts {
  name: string;
  uom: string;
  listPrice: number;
  /** Accurate's base unit and extra units (accurate_items). */
  baseUom: string;
  units: UnitFactor[];
}

export interface BelowCostRow {
  invoiceNo: string;
  transDate: string;
  customerName: string;
  code: string;
  name: string;
  /** Per base unit, before PPN. */
  net: number;
  cost: number;
  receiptNo: string;
  /** (cost - net) x base units sold, net of returns. */
  lossTotal: number;
}

export interface BelowCostResult {
  /** Lines compared with a cost. */
  checked: number;
  below: BelowCostRow[];
  /** Lines with no usable receipt on or before the invoice date: not counted as a loss. */
  unknownCost: number;
  /** The receipt cost is 3x the selling price or more (a pack recorded as 1 PCS): not counted either. */
  doubtfulCost: number;
}

/** Under a rupiah is rounding, not a loss. */
const TOLERANCE = 1;

export function findBelowCost(
  sales: SalesLine[],
  receiptsByItem: Map<string, ReceiptLine[]>,
  catalog: Map<string, CatalogFacts>,
): BelowCostResult {
  const out: BelowCostResult = { checked: 0, below: [], unknownCost: 0, doubtfulCost: 0 };
  for (const l of sales) {
    const net = netPerBaseUnit(l);
    const item = catalog.get(l.itemCode);
    if (net === null || !item) continue;
    const before = (receiptsByItem.get(l.itemCode) ?? []).filter((r) => r.transDate <= l.transDate);
    const c = lastPurchaseCost(before, { baseUom: item.baseUom, units: item.units }, item.uom);
    if (!c.ok) {
      out.unknownCost++;
      continue;
    }
    if (item.listPrice > 0 && c.cost >= LIST_HOLD_RATIO * item.listPrice) {
      out.doubtfulCost++;
      continue;
    }
    out.checked++;
    if (net < c.cost - TOLERANCE) {
      const sold = (l.quantity - l.returnQty) * (l.unitRatio > 0 ? l.unitRatio : 1);
      out.below.push({
        invoiceNo: l.invoiceNo,
        transDate: l.transDate,
        customerName: l.customerName,
        code: l.itemCode,
        name: item.name,
        net: Math.round(net * 100) / 100,
        cost: c.cost,
        receiptNo: c.receiptNo,
        lossTotal: Math.round((c.cost - net) * sold),
      });
    }
  }
  out.below.sort((a, b) => b.lossTotal - a.lossTotal || a.code.localeCompare(b.code));
  return out;
}
