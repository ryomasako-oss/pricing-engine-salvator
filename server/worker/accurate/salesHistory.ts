/* ============================================================
   Riwayat penjualan (SI) per barang, read-only, the sales-side twin of
   cogsHistory.ts: the latest sales-invoice lines of each catalog item and
   the wordings it was invoiced under, so matching a client's list can be
   checked against what was actually sold. Searches the code, the catalog
   name, the invoice wording (detail_name) and the customer, so typing a
   client's wording shows which items it was invoiced as.
   ============================================================ */

import { all, get } from "../../db.d1";
import { netPerBaseUnit } from "../../../shared/salesBelowCost";
import type { EntityKey } from "./sync";

export const SALES_HISTORY_PAGE_SIZE = 20;
/** Newest invoice lines shown on one card. */
const PER_CARD = 10;
/** Wordings shown on one card, most invoiced first. */
const NAMES_PER_CARD = 8;

export interface HistorySale {
  invoiceNo: string;
  transDate: string;
  customerName: string;
  /** How the line was worded on the invoice. */
  detailName: string;
  unit: string;
  quantity: number;
  /** Net per invoice unit after every discount, before PPN; null when the line was fully returned. */
  price: number | null;
  /** Same, per Accurate base unit (`baseUom`). */
  perBase: number | null;
}

export interface SalesHistoryCard {
  code: string;
  name: string;
  uom: string;
  /** Accurate's base unit of the item (the catalog unit when Accurate has no record), what `perBase` is per. */
  baseUom: string;
  sales: HistorySale[];
  names: { name: string; count: number }[];
}

export interface SalesHistoryPage {
  total: number;
  page: number;
  pageSize: number;
  cards: SalesHistoryCard[];
}

export async function salesHistory(
  db: D1Database,
  entity: EntityKey,
  opts: { q: string; page: number },
): Promise<SalesHistoryPage> {
  const like = `%${opts.q.replace(/[\\%_]/g, "\\$&")}%`;
  // EXISTS walks idx_sales_lines_item per item; the wording/customer IN runs once, not per item (D1 rows read).
  const where = `EXISTS (SELECT 1 FROM accurate_sales_lines s WHERE s.entity = ?1 AND s.item_code = c.code)
                 AND (c.code LIKE ?2 ESCAPE '\\' OR c.name LIKE ?2 ESCAPE '\\'
                      OR c.code IN (SELECT item_code FROM accurate_sales_lines
                                     WHERE entity = ?1 AND (detail_name LIKE ?2 ESCAPE '\\' OR customer_name LIKE ?2 ESCAPE '\\')))`;

  const total = (await get<{ n: number }>(db, `SELECT COUNT(*) AS n FROM catalog_items c WHERE ${where}`, entity, like))?.n ?? 0;
  const page = Math.max(1, opts.page);
  // Most recently sold first: that is the item a matcher most likely means.
  const items = await all<{ code: string; name: string; uom: string; base_uom: string }>(
    db,
    `SELECT c.code, c.name, c.uom,
            COALESCE((SELECT NULLIF(a.uom, '') FROM accurate_items a WHERE a.entity = ?1 AND a.code = c.code), c.uom) AS base_uom
       FROM catalog_items c
      WHERE ${where}
      ORDER BY (SELECT MAX(trans_date) FROM accurate_sales_lines s WHERE s.entity = ?1 AND s.item_code = c.code) DESC, c.code
      LIMIT ?3 OFFSET ?4`,
    entity,
    like,
    SALES_HISTORY_PAGE_SIZE,
    (page - 1) * SALES_HISTORY_PAGE_SIZE,
  );
  const codes = JSON.stringify(items.map((i) => i.code));

  const lines = await all<{
    item_code: string; invoice_no: string; trans_date: string; customer_name: string; detail_name: string; unit: string;
    unit_ratio: number; quantity: number; return_qty: number; sales_amount: number; inclusive_tax: number; tax_rate: number;
    cash_discount: number; sub_total: number;
  }>(
    db,
    `SELECT item_code, invoice_no, trans_date, customer_name, detail_name, unit, unit_ratio, quantity, return_qty,
            sales_amount, inclusive_tax, tax_rate, cash_discount, sub_total
       FROM (SELECT s.*, ROW_NUMBER() OVER (
                      PARTITION BY s.item_code ORDER BY s.trans_date DESC, s.invoice_id DESC, s.line_id DESC) AS rn
               FROM accurate_sales_lines s
              WHERE s.entity = ?1 AND s.item_code IN (SELECT value FROM json_each(?2)))
      WHERE rn <= ${PER_CARD}
      ORDER BY item_code, rn`,
    entity,
    codes,
  );
  const names = await all<{ item_code: string; name: string; n: number }>(
    db,
    `SELECT item_code, detail_name AS name, COUNT(*) AS n
       FROM accurate_sales_lines
      WHERE entity = ?1 AND detail_name <> '' AND item_code IN (SELECT value FROM json_each(?2))
      GROUP BY item_code, detail_name
      ORDER BY item_code, n DESC, name`,
    entity,
    codes,
  );

  const round = (n: number) => Math.round(n * 100) / 100;
  const cards = items.map(({ base_uom, ...i }): SalesHistoryCard => ({
    ...i,
    baseUom: base_uom,
    sales: lines
      .filter((l) => l.item_code === i.code)
      .map((l): HistorySale => {
        const ratio = l.unit_ratio > 0 ? l.unit_ratio : 1;
        const net = netPerBaseUnit({
          invoiceNo: l.invoice_no, transDate: l.trans_date, customerName: l.customer_name, itemCode: l.item_code,
          unit: l.unit, unitRatio: ratio, quantity: l.quantity, returnQty: l.return_qty, salesAmount: l.sales_amount,
          inclusiveTax: l.inclusive_tax === 1, taxRate: l.tax_rate, cashDiscount: l.cash_discount, subTotal: l.sub_total,
        });
        return {
          invoiceNo: l.invoice_no,
          transDate: l.trans_date,
          customerName: l.customer_name,
          detailName: l.detail_name,
          unit: l.unit,
          quantity: l.quantity,
          price: net === null ? null : round(net * ratio),
          perBase: net === null ? null : round(net),
        };
      }),
    names: names
      .filter((n) => n.item_code === i.code)
      .slice(0, NAMES_PER_CARD)
      .map((n) => ({ name: n.name, count: n.n })),
  }));
  return { total, page, pageSize: SALES_HISTORY_PAGE_SIZE, cards };
}
