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

/* ---------- Goods receipts (Penerimaan Barang) ---------- */

/** Fields requested from /receive-item/list.do; the lines come from detail.do. */
export const RECEIPT_LIST_FIELDS = "id,number,transDate,lastUpdate,status,approvalStatus";

/** Receipts that never put goods in stock: no detail call, and lines stored earlier are dropped. */
const NOT_RECEIVED = new Set(["DRAFT", "UNAPPROVED", "REJECTED"]);

/** Accurate "dd/MM/yyyy" → "yyyy-MM-dd"; anything else → "". */
export function isoDate(v: unknown): string {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(str(v));
  return m ? `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}` : "";
}

/** Accurate "dd/MM/yyyy HH:mm:ss" → a key that sorts in time order ("yyyy-MM-dd HH:mm:ss"), or "". */
export function updateKey(v: unknown): string {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(str(v));
  if (!m) return "";
  const t = `${(m[4] ?? "0").padStart(2, "0")}:${m[5] ?? "00"}:${m[6] ?? "00"}`;
  return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")} ${t}`;
}

export interface StagedReceipt {
  accurateId: number;
  number: string;
  /** As Accurate sent it, for the next pass's filter. */
  lastUpdate: string;
  /** False for drafts, unapproved and rejected receipts. */
  received: boolean;
}

export function mapReceipt(r: Row): StagedReceipt | null {
  const accurateId = num(r.id);
  if (!accurateId) return null;
  const status = (str(r.status) || str(r.approvalStatus)).toUpperCase();
  return { accurateId, number: str(r.number), lastUpdate: str(r.lastUpdate), received: !NOT_RECEIVED.has(status) };
}

export interface StagedReceiptLine {
  receiptId: number;
  lineId: number;
  receiptNo: string;
  transDate: string;
  itemCode: string;
  unit: string;
  quantity: number;
  unitPrice: number;
}

/** A /receive-item/detail.do "d" object → its item lines. Lines without an item code are dropped. */
export function mapReceiptLines(d: Row): StagedReceiptLine[] {
  const receiptId = num(d.id);
  const transDate = isoDate(d.transDate);
  if (!receiptId || !transDate) return [];
  const lines = Array.isArray(d.detailItem) ? (d.detailItem as Row[]) : [];
  const out: StagedReceiptLine[] = [];
  lines.forEach((l, i) => {
    const item = (l.item ?? {}) as Row;
    const itemCode = str(l.itemNo) || str(item.no);
    if (!itemCode) return;
    out.push({
      receiptId,
      lineId: num(l.id) || i + 1,
      receiptNo: str(d.number),
      transDate,
      itemCode,
      unit: nameOf(l.itemUnitName, l.itemUnit) || str(l.unitName),
      quantity: num(l.quantity),
      unitPrice: Math.max(0, num(l.unitPrice)),
    });
  });
  return out;
}
