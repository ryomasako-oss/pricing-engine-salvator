/* ============================================================
   Riwayat pembelian (PI) per barang, read-only: the purchase-side twin of
   salesHistory.ts. The latest purchase-invoice lines of each catalog item
   (accurate_purchase_lines, synced by accurate/receipts.ts), with the price as
   written on the invoice and the modal it gives: after the item and invoice
   discounts, before PPN (accurate/mapping.ts mapPurchaseLines). Searches the
   code, the catalog name and the PI number. The supplier is not synced yet.
   ============================================================ */

import { all, get } from "../../db.d1";
import type { EntityKey } from "./sync";

export const PURCHASE_HISTORY_PAGE_SIZE = 20;
/** Newest invoice lines shown on one card. */
const PER_CARD = 10;

export interface HistoryPurchase {
  invoiceNo: string;
  transDate: string;
  unit: string;
  quantity: number;
  /** Unit price as written on the PI (before discounts; includes PPN when `inclusiveTax`). */
  invoicePrice: number;
  /** Modal per PI unit: after the item and invoice discounts, before PPN. */
  price: number;
  /** "Total termasuk pajak" was ticked on the PI. */
  inclusiveTax: boolean;
}

export interface PurchaseHistoryCard {
  code: string;
  name: string;
  uom: string;
  purchases: HistoryPurchase[];
}

export interface PurchaseHistoryPage {
  total: number;
  page: number;
  pageSize: number;
  cards: PurchaseHistoryCard[];
}

export async function purchaseHistory(
  db: D1Database,
  entity: EntityKey,
  opts: { q: string; page: number },
): Promise<PurchaseHistoryPage> {
  const like = `%${opts.q.replace(/[\\%_]/g, "\\$&")}%`;
  // EXISTS walks idx_purchase_lines_item per item; the PI-number IN runs once, not per item (D1 rows read).
  const where = `EXISTS (SELECT 1 FROM accurate_purchase_lines p WHERE p.entity = ?1 AND p.item_code = c.code)
                 AND (c.code LIKE ?2 ESCAPE '\\' OR c.name LIKE ?2 ESCAPE '\\'
                      OR c.code IN (SELECT item_code FROM accurate_purchase_lines WHERE entity = ?1 AND receipt_no LIKE ?2 ESCAPE '\\'))`;

  const total = (await get<{ n: number }>(db, `SELECT COUNT(*) AS n FROM catalog_items c WHERE ${where}`, entity, like))?.n ?? 0;
  const page = Math.max(1, opts.page);
  // Most recently bought first.
  const items = await all<{ code: string; name: string; uom: string }>(
    db,
    `SELECT c.code, c.name, c.uom
       FROM catalog_items c
      WHERE ${where}
      ORDER BY (SELECT MAX(trans_date) FROM accurate_purchase_lines p WHERE p.entity = ?1 AND p.item_code = c.code) DESC, c.code
      LIMIT ?3 OFFSET ?4`,
    entity,
    like,
    PURCHASE_HISTORY_PAGE_SIZE,
    (page - 1) * PURCHASE_HISTORY_PAGE_SIZE,
  );
  const lines = await all<{
    item_code: string; receipt_no: string; trans_date: string; unit: string; quantity: number;
    unit_price: number; unit_price_gross: number; inclusive_tax: number;
  }>(
    db,
    `SELECT item_code, receipt_no, trans_date, unit, quantity, unit_price, unit_price_gross, inclusive_tax
       FROM (SELECT p.*, ROW_NUMBER() OVER (
                      PARTITION BY p.item_code ORDER BY p.trans_date DESC, p.receipt_id DESC, p.line_id DESC) AS rn
               FROM accurate_purchase_lines p
              WHERE p.entity = ?1 AND p.item_code IN (SELECT value FROM json_each(?2)))
      WHERE rn <= ${PER_CARD}
      ORDER BY item_code, rn`,
    entity,
    JSON.stringify(items.map((i) => i.code)),
  );

  const round = (n: number) => Math.round(n * 100) / 100;
  const cards = items.map(
    (i): PurchaseHistoryCard => ({
      ...i,
      purchases: lines
        .filter((l) => l.item_code === i.code)
        .map((l) => ({
          invoiceNo: l.receipt_no,
          transDate: l.trans_date,
          unit: l.unit,
          quantity: l.quantity,
          invoicePrice: round(l.unit_price_gross),
          price: round(l.unit_price),
          inclusiveTax: l.inclusive_tax === 1,
        })),
    }),
  );
  return { total, page, pageSize: PURCHASE_HISTORY_PAGE_SIZE, cards };
}
