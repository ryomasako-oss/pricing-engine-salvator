/* Which price columns the customer-facing quotation shows. A rep can send a
   plain price list (no quantities) or drop the per-line totals; both default
   to shown so existing quotes print exactly as before.

   A client may also carry a document template (its tender format): the
   columns, their headings, a title and opening/closing text. The PDF, the
   on-screen document and the Excel sheet all read it through docLayout, so the
   three cannot drift. The quote's own options can only hide more: hideQty and
   hideLineTotal still drop those columns (and the totals) from a template. */

import { pct } from "./format";
import { shownCode } from "./pendingItems";
import type { Assumptions, ComputedRow, DocColumnKey, DocTemplate, QuoteMeta, ScenarioResult, TotalRowKey } from "./types";

export interface DocColumns {
  qty: boolean;
  lineTotal: boolean;
  /** Subtotal / PPN / contract value. Without a quantity there is nothing to add up, so these go with it. */
  totals: boolean;
}

export function docColumns(meta: Pick<QuoteMeta, "hideQty" | "hideLineTotal">): DocColumns {
  const qty = !meta.hideQty;
  return { qty, lineTotal: qty && !meta.hideLineTotal, totals: qty };
}

/** Standard heading of every column a template may use; also the allowlist (server/validate.ts). */
export const DOC_COLUMN_LABELS: Record<DocColumnKey, string> = {
  no: "No",
  code: "Kode",
  name: "Item",
  uom: "Satuan",
  qty: "Qty",
  price: "Harga satuan",
  total: "Total per bulan",
  notes: "Keterangan",
};
export const DOC_COLUMN_KEYS = Object.keys(DOC_COLUMN_LABELS) as DocColumnKey[];
export const DEFAULT_DOC_TITLE = "Penawaran Harga";

/* The standard tables, as they printed before templates: the PDF and the
   preview put the code under the item name, the Excel sheet in its own column. */
const STANDARD: Record<"print" | "sheet", DocColumnKey[]> = {
  print: ["no", "name", "uom", "qty", "price", "total"],
  sheet: ["no", "code", "name", "uom", "qty", "price", "total"],
};

/** The totals block, top to bottom. Each row can be left off a quote on its own (meta.hideTotalRows). */
export const TOTAL_ROW_KEYS: TotalRowKey[] = ["subtotal", "ppn", "monthly", "contract"];

export interface DocLayout {
  columns: { key: DocColumnKey; label: string }[];
  /** True when at least one total row is printed. */
  totals: boolean;
  totalRows: TotalRowKey[];
  title: string;
  opening: string;
  closing: string;
  /** The item cell also shows the code: the standard print layout only, a template places the code itself. */
  codeUnderName: boolean;
}

export function docLayout(
  meta: Pick<QuoteMeta, "hideQty" | "hideLineTotal" | "hideTotalRows">,
  template: DocTemplate | null | undefined,
  target: "print" | "sheet",
): DocLayout {
  const cols = docColumns(meta);
  const t = template ?? {};
  // Unknown keys are dropped here too, not only by the API: a row edited by hand must not print other data.
  const picked = (t.columns ?? []).filter((c, i, all) => c.key in DOC_COLUMN_LABELS && all.findIndex((o) => o.key === c.key) === i);
  const base = picked.length
    ? picked.map((c) => ({ key: c.key, label: c.label.trim() || DOC_COLUMN_LABELS[c.key] }))
    : STANDARD[target].map((key) => ({ key, label: DOC_COLUMN_LABELS[key] }));
  const hidden = meta.hideTotalRows ?? [];
  const totalRows = cols.totals && t.showTotals !== false ? TOTAL_ROW_KEYS.filter((k) => !hidden.includes(k)) : [];
  return {
    columns: base.filter((c) => (c.key !== "qty" || cols.qty) && (c.key !== "total" || cols.lineTotal)),
    totals: totalRows.length > 0,
    totalRows,
    title: t.title?.trim() || DEFAULT_DOC_TITLE,
    opening: t.opening?.trim() ?? "",
    closing: t.closing?.trim() ?? "",
    codeUnderName: !picked.length && target === "print",
  };
}

/** One cell's raw value; each output formats numbers its own way. */
export function docCell(key: DocColumnKey, r: ComputedRow, price: number): string | number {
  switch (key) {
    case "no": return r.lineNo;
    case "code": return shownCode(r.code);
    case "name": return r.name;
    case "uom": return r.uom;
    case "qty": return r.qty;
    case "price": return price;
    case "total": return price * r.qty;
    case "notes": return r.notes ?? "";
  }
}

/** The printed total rows with their labels and values, so preview, PDF and Excel add up the same way. */
export function docTotals(
  layout: Pick<DocLayout, "totalRows">,
  s: Pick<ScenarioResult, "revenue" | "annual">,
  assumptions: Pick<Assumptions, "ppn" | "months">,
): { key: TotalRowKey; label: string; value: number }[] {
  const all: Record<TotalRowKey, [string, number]> = {
    subtotal: ["Subtotal per bulan", s.revenue],
    ppn: [`PPN ${pct(assumptions.ppn, 0)}`, s.revenue * assumptions.ppn],
    monthly: ["Total per bulan", s.revenue * (1 + assumptions.ppn)],
    contract: [`Nilai kontrak ${assumptions.months} bulan (belum PPN)`, s.annual],
  };
  return layout.totalRows.map((key) => ({ key, label: all[key][0], value: all[key][1] }));
}
