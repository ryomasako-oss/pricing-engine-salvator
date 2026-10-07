/* Pure mapping from Accurate list rows to staging rows.
   Accurate returns some fields flat (unit1Name) and some as nested
   objects (unit1: { name }), depending on endpoint and the `fields`
   requested, so every read accepts both shapes. */

import { cleanUnits } from "../../../shared/uom";
import type { UnitFactor } from "../../../shared/types";

/** Fields requested from /item/list.do. Both flat (unit1Name) and nested (unit1) names are
    asked for because the shape differs by database; verify with GET /api/accurate/probe. */
export const ITEM_FIELDS = [
  "id",
  "no",
  "name",
  "itemType",
  "unitPrice",
  "unit1Name",
  "unit2Name",
  "unit3Name",
  "unit4Name",
  "unit5Name",
  "unit1",
  "unit2",
  "unit3",
  "unit4",
  "unit5",
  "ratio2",
  "ratio3",
  "ratio4",
  "ratio5",
  "itemCategory",
  "itemCategoryName",
  "suspended",
].join(",");

export interface StagedItem {
  accurateId: number;
  code: string;
  name: string;
  itemType: string;
  uom: string;
  unitPrice: number;
  units: UnitFactor[];
  category: string;
  suspended: boolean;
}

type Row = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");
const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.replace(/,/g, "")) : NaN;
  return Number.isFinite(n) ? n : 0;
};
const nameOf = (flat: unknown, nested: unknown): string =>
  str(flat) || (nested && typeof nested === "object" ? str((nested as Row).name) : str(nested));

export function mapItem(r: Row): StagedItem | null {
  const accurateId = num(r.id);
  const code = str(r.no);
  if (!accurateId || !code) return null;
  const uom = nameOf(r.unit1Name, r.unit1);
  const extra: UnitFactor[] = [];
  for (const n of [2, 3, 4, 5]) {
    const u = nameOf(r[`unit${n}Name`], r[`unit${n}`]);
    const f = num(r[`ratio${n}`]);
    if (u && f > 0) extra.push({ uom: u, factor: f });
  }
  return {
    accurateId,
    code,
    name: str(r.name),
    itemType: str(r.itemType),
    uom,
    unitPrice: Math.max(0, num(r.unitPrice)),
    units: cleanUnits(uom || undefined, extra),
    category: nameOf(r.itemCategoryName, r.itemCategory),
    suspended: r.suspended === true || r.suspended === "true",
  };
}

export interface StagedStock {
  code: string;
  quantity: number;
}

/** A /item/list-stock.do row → item code + quantity in that warehouse. */
export function mapStock(r: Row): StagedStock | null {
  const code = str(r.no) || str(r.itemNo) || str((r.item as Row | undefined)?.no);
  if (!code) return null;
  const q = r.quantity ?? r.availableToSell ?? r.balance ?? r.qty ?? r.quantityInAllUnit;
  return { code, quantity: num(q) };
}

export interface StagedWarehouse {
  accurateId: number;
  name: string;
}

export function mapWarehouse(r: Row): StagedWarehouse | null {
  const accurateId = num(r.id);
  if (!accurateId) return null;
  return { accurateId, name: str(r.name) };
}
