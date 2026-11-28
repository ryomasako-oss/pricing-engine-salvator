/* Surat perubahan harga (Ryoma, 2026-11-26): for an SI with a real loss, the analysis per item and the
   lines of the official letter to the client.

   "Real loss" = the Jual < Beli groups "Belum ketemu penyebabnya" and "Perlu diberi harga". A row the
   report reads as a data slip, a non-sale, or a bonus the invoice still covers is no reason to raise
   a client's price. One line per item even when the SI lists it several times, priced in the unit
   the client bought it in, before PPN (as Accurate's salesAmount and the PI's unitPrice are).

   The suggested price is the cheapest one a quote could carry without a margin breach: the PI cost
   plus opex, at the policy's minimum net margin, rounded up like the engine (priceForMargin). Pure. */

import { groupOf, type GroupKey } from "./belowCostHints.js";
import { priceForMargin } from "./engine.js";
import type { BelowCostRow } from "./salesBelowCost.js";

export const REAL_LOSS_GROUPS: readonly GroupKey[] = ["none", "pricing"];

export const isRealLoss = (r: Pick<BelowCostRow, "hints">) => REAL_LOSS_GROUPS.includes(groupOf(r.hints).key);

/**
 * A line given free with no paid line of the same item on the SI (e.g. a memory card with a CCTV): nothing to
 * average, and "Rp 0 -> new price" is no letter to send a client who got it as a bonus. Left out of the letter;
 * a manager decides (Ryoma, 28 Nov).
 */
export const isFreeWithoutPaid = (r: Pick<BelowCostRow, "avgNet" | "trace">) => r.trace.lineAmount === 0 && !(r.avgNet > 0);

export interface LetterLine {
  code: string;
  name: string;
  /** The unit the client bought in, and base units in it. */
  unit: string;
  ratio: number;
  /** Per `unit`, before PPN: what the client paid on average on this SI, and the PI cost. */
  oldPrice: number;
  cost: number;
  receiptNo: string;
  /** Net margin of the old price after opex; negative is a loss. */
  marginNow: number;
  suggested: number;
  /** The SI's loss on this item, all lines. */
  lossTotal: number;
  group: GroupKey;
}

export interface MarginRule {
  minNetMargin: number;
  opex: number;
  step: number;
}

export const netMargin = (price: number, cost: number, opex: number) => (price > 0 ? (price - cost * (1 + opex)) / price : -1);

export function letterLines(rows: BelowCostRow[], rule: MarginRule): LetterLine[] {
  const byCode = new Map<string, BelowCostRow[]>();
  for (const r of rows.filter((x) => isRealLoss(x) && !isFreeWithoutPaid(x))) byCode.set(r.code, [...(byCode.get(r.code) ?? []), r]);
  return [...byCode.values()].map((rs) => {
    // The client's unit: a paid line's, else the free line's. The old price is the item's average over the SI
    // (bonus units included), never Rp 0: a free line here always has paid units of the same item.
    const r = rs.find((x) => x.trace.lineAmount > 0) ?? rs[0];
    const ratio = r.trace.unitRatio > 0 ? r.trace.unitRatio : 1;
    const cost = Math.round(r.cost * ratio);
    const oldPrice = Math.round(r.avgNet * ratio);
    return {
      code: r.code,
      name: r.name,
      unit: r.trace.unit || r.trace.baseUom,
      ratio,
      oldPrice,
      cost,
      receiptNo: r.receiptNo,
      marginNow: netMargin(oldPrice, cost, rule.opex),
      suggested: priceForMargin(cost * (1 + rule.opex), rule.minNetMargin, rule.step),
      lossTotal: rs.reduce((s, x) => s + x.lossTotal, 0),
      group: groupOf(r.hints).key,
    };
  });
}

/** Why a new price can't go on the letter, or null. */
export function newPriceRefusal(line: Pick<LetterLine, "cost" | "name">, price: number): string | null {
  if (!Number.isInteger(price) || price <= 0) return `Harga baru ${line.name} harus angka rupiah bulat di atas 0.`;
  if (price <= line.cost) return `Harga baru ${line.name} masih di bawah atau sama dengan harga beli, jadi tetap rugi.`;
  return null;
}
