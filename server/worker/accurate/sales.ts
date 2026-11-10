/* ============================================================
   Accurate sales invoices (Faktur Penjualan, "SI") → accurate_sales_lines
   (Ryoma, 2026-11-04): what each client actually paid, the last 12 months.
   Read for the ceiling of a new quote line and for the morning recap's
   "dijual di bawah modal".

   The same pass as goods receipts (receipts.ts docStep): every invoice read
   once, one detail call each, again only when its lastUpdate moves, and a
   periodic sweep drops invoices Accurate deleted. It runs in the receipts
   cron tick, only when receipts had nothing to do (index.ts), so the two
   never share one tick's call budget.

   Off unless ACCURATE_SALES_ENABLED = "true".
   ============================================================ */

import { all, get, run } from "../../db.d1";
import type { ReceiptLine } from "../../../shared/lastPurchaseCost";
import { findBelowCost, netPerBaseUnit, type BelowCostResult, type CatalogFacts, type SalesLine } from "../../../shared/salesBelowCost";
import { parseUnits } from "./purchaseCost";
import { SALES_LIST_FIELDS, mapSalesInvoice, mapSalesLines } from "./mapping";
import { RECEIPT_LINES, docStep, receiptConfig, type CostLines, type DocKind, type ReceiptState } from "./receipts";
import { catalogEntity, credsFor, syncConfig, type EntityKey } from "./sync";
import type { Bindings } from "../env";

export const SALES: DocKind = {
  stateTable: "accurate_sales_state",
  linesTable: "accurate_sales_lines",
  docColumn: "invoice_id",
  path: "sales-invoice",
  listFields: SALES_LIST_FIELDS,
  mapDoc: mapSalesInvoice,
  mapLines: mapSalesLines,
  insertSql: `INSERT OR REPLACE INTO accurate_sales_lines(entity, invoice_id, line_id, invoice_no, trans_date, customer_no,
                customer_name, item_code, detail_name, name_key, unit, unit_ratio, quantity, return_qty, sales_amount,
                inclusive_tax, tax_rate, cash_discount, sub_total, synced_at)
              SELECT ?1, json_extract(j.value, '$.invoiceId'), json_extract(j.value, '$.lineId'),
                     json_extract(j.value, '$.invoiceNo'), json_extract(j.value, '$.transDate'),
                     json_extract(j.value, '$.customerNo'), json_extract(j.value, '$.customerName'),
                     json_extract(j.value, '$.itemCode'), json_extract(j.value, '$.detailName'),
                     json_extract(j.value, '$.nameKey'), json_extract(j.value, '$.unit'),
                     json_extract(j.value, '$.unitRatio'), json_extract(j.value, '$.quantity'),
                     json_extract(j.value, '$.returnQty'), json_extract(j.value, '$.salesAmount'),
                     json_extract(j.value, '$.inclusiveTax'), json_extract(j.value, '$.taxRate'),
                     json_extract(j.value, '$.cashDiscount'), json_extract(j.value, '$.subTotal'), datetime('now')
                FROM json_each(?2) j WHERE true`,
};

export const salesEnabled = (env: Pick<Bindings, "ACCURATE_SALES_ENABLED">) => env.ACCURATE_SALES_ENABLED === "true";

export async function loadSalesState(db: D1Database, entity: EntityKey): Promise<ReceiptState> {
  await run(db, "INSERT OR IGNORE INTO accurate_sales_state(entity) VALUES(?)", entity);
  return (await get<ReceiptState>(db, "SELECT * FROM accurate_sales_state WHERE entity = ?", entity))!;
}

export async function salesTick(env: Bindings, opts: { deadlineMs: number; fetchImpl?: typeof fetch; gapMs?: number }) {
  if (!salesEnabled(env) || env.ACCURATE_SYNC_ENABLED === "false") return null;
  const entity = catalogEntity(env);
  const creds = credsFor(env, entity);
  if (!creds) return null;
  // Same window and page size as receipts: one year back on the first pass.
  return docStep(SALES, env.DB, entity, creds, receiptConfig(env), {
    budget: syncConfig(env).callsPerTick,
    deadline: Date.now() + opts.deadlineMs,
    fetchImpl: opts.fetchImpl,
    gapMs: opts.gapMs,
  });
}

interface SalesRow {
  invoice_no: string; trans_date: string; customer_name: string; item_code: string; unit: string; unit_ratio: number;
  quantity: number; return_qty: number; sales_amount: number; inclusive_tax: number; tax_rate: number;
  cash_discount: number; sub_total: number; synced_at: string; detail_name: string;
  name: string; catalog_uom: string; list_price: number; accurate_uom: string; units: string;
}

/**
 * Invoice lines synced after `cursor` (null: all of them, the first recap after the backfill),
 * compared with the purchase price of their date. Two reads: the new lines with their catalog and
 * Accurate units, then the receipt lines of only those items. `cursor` is the highest synced_at seen,
 * for the next recap; an edited invoice is re-synced and so reported again.
 */
export async function salesBelowCostSince(
  db: D1Database,
  entity: EntityKey,
  cursor: string | null,
  lines: CostLines = RECEIPT_LINES,
): Promise<{ result: BelowCostResult; cursor: string | null }> {
  return belowCost(db, entity, "s.synced_at > ?2", [cursor ?? ""], lines, cursor);
}

/**
 * Laporan "Jual di bawah beli" (Ryoma, 2026-11-10): the same comparison as the recap, for invoices
 * dated `from`..`to` (YYYY-MM-DD, inclusive), read on demand from the report tab.
 */
export async function salesBelowCostBetween(db: D1Database, entity: EntityKey, from: string, to: string, lines: CostLines = RECEIPT_LINES) {
  return (await belowCost(db, entity, "s.trans_date BETWEEN ?2 AND ?3", [from, to], lines, null)).result;
}

async function belowCost(
  db: D1Database,
  entity: EntityKey,
  where: string,
  params: string[],
  lines: CostLines,
  cursor: string | null,
): Promise<{ result: BelowCostResult; cursor: string | null }> {
  const rows = await all<SalesRow>(
    db,
    `SELECT s.invoice_no, s.trans_date, s.customer_name, s.item_code, s.unit, s.unit_ratio, s.quantity, s.return_qty,
            s.sales_amount, s.inclusive_tax, s.tax_rate, s.cash_discount, s.sub_total, s.synced_at, s.detail_name,
            c.name, c.uom AS catalog_uom, c.list_price, COALESCE(NULLIF(i.uom, ''), 'Pcs') AS accurate_uom, i.units
       FROM accurate_sales_lines s
       JOIN catalog_items c ON c.code = s.item_code
       JOIN accurate_items i ON i.entity = ?1 AND i.code = s.item_code
      WHERE s.entity = ?1 AND ${where}`,
    entity,
    ...params,
  );
  const codes = [...new Set(rows.map((r) => r.item_code))];
  const receipts = new Map<string, ReceiptLine[]>();
  if (codes.length) {
    const ri = await all<{ item_code: string; receipt_id: number; line_id: number; receipt_no: string; trans_date: string; unit: string; quantity: number; unit_price: number }>(
      db,
      `SELECT item_code, receipt_id, line_id, receipt_no, trans_date, unit, quantity, unit_price
         FROM ${lines}
        WHERE entity = ?1 AND unit_price > 0 AND quantity > 0 AND item_code IN (SELECT value FROM json_each(?2))`,
      entity,
      JSON.stringify(codes),
    );
    for (const r of ri) {
      const line = { receiptId: r.receipt_id, lineId: r.line_id, receiptNo: r.receipt_no, transDate: r.trans_date, unit: r.unit, quantity: r.quantity, unitPrice: r.unit_price };
      const list = receipts.get(r.item_code);
      if (list) list.push(line);
      else receipts.set(r.item_code, [line]);
    }
  }
  const catalog = new Map<string, CatalogFacts>();
  const sales: SalesLine[] = [];
  let next = cursor;
  for (const r of rows) {
    if (!catalog.has(r.item_code)) {
      catalog.set(r.item_code, { name: r.name, uom: r.catalog_uom, listPrice: r.list_price, baseUom: r.accurate_uom, units: parseUnits(r.units) });
    }
    sales.push({
      invoiceNo: r.invoice_no, transDate: r.trans_date, customerName: r.customer_name, itemCode: r.item_code, unit: r.unit,
      unitRatio: r.unit_ratio, quantity: r.quantity, returnQty: r.return_qty, salesAmount: r.sales_amount,
      inclusiveTax: r.inclusive_tax === 1, taxRate: r.tax_rate, cashDiscount: r.cash_discount, subTotal: r.sub_total,
      detailName: r.detail_name ?? "",
    });
    if (!next || r.synced_at > next) next = r.synced_at;
  }
  return { result: findBelowCost(sales, receipts, catalog), cursor: next };
}

export type LastSale = { price: number; invoiceNo: string; date: string; ownClient: boolean };

/**
 * Default ceiling of a client's list (Ryoma, 2026-11-04): the net price per base unit on the latest
 * invoice of the last 12 months, to this client (customerNo) if it bought the item, otherwise to
 * anyone. A price under the item's current COGS is passed over, so a past loss doesn't pin the new
 * quote below cost too. Only for items whose catalog unit is Accurate's base unit, as for COGS.
 */
export async function lastSales(
  db: D1Database,
  entity: EntityKey,
  items: { code: string; uom: string; cogs: number }[],
  customerNo: string,
  now = new Date(),
): Promise<Map<string, LastSale>> {
  const out = new Map<string, LastSale>();
  if (!items.length) return out;
  const since = new Date(now.getTime() - 365 * 86_400_000).toISOString().slice(0, 10);
  const rows = await all<SalesRow & { customer_no: string; accurate_uom: string }>(
    db,
    `SELECT s.invoice_no, s.trans_date, s.customer_no, s.item_code, s.unit_ratio, s.quantity, s.return_qty, s.sales_amount,
            s.inclusive_tax, s.tax_rate, s.cash_discount, s.sub_total, COALESCE(NULLIF(i.uom, ''), 'Pcs') AS accurate_uom
       FROM accurate_sales_lines s
       JOIN accurate_items i ON i.entity = ?1 AND i.code = s.item_code
      WHERE s.entity = ?1 AND s.trans_date >= ?2 AND s.item_code IN (SELECT value FROM json_each(?3))
      ORDER BY s.trans_date DESC, s.invoice_id DESC, s.line_id DESC`,
    entity,
    since,
    JSON.stringify(items.map((i) => i.code)),
  );
  const byCode = new Map(items.map((i) => [i.code, i]));
  const anyClient = new Map<string, LastSale>();
  for (const r of rows) {
    const item = byCode.get(r.item_code);
    if (!item || r.accurate_uom.trim().toLowerCase() !== item.uom.trim().toLowerCase()) continue;
    const own = !!customerNo && r.customer_no === customerNo;
    if (out.has(r.item_code) || (!own && anyClient.has(r.item_code))) continue;
    const net = netPerBaseUnit({
      invoiceNo: r.invoice_no, transDate: r.trans_date, customerName: "", itemCode: r.item_code, unit: "", unitRatio: r.unit_ratio,
      quantity: r.quantity, returnQty: r.return_qty, salesAmount: r.sales_amount, inclusiveTax: r.inclusive_tax === 1,
      taxRate: r.tax_rate, cashDiscount: r.cash_discount, subTotal: r.sub_total,
    });
    if (net === null || net <= 0 || (item.cogs > 0 && net < item.cogs)) continue;
    const sale = { price: Math.round(net * 100) / 100, invoiceNo: r.invoice_no, date: r.trans_date, ownClient: own };
    if (own) out.set(r.item_code, sale);
    else anyClient.set(r.item_code, sale);
  }
  for (const [code, sale] of anyClient) if (!out.has(code)) out.set(code, sale);
  return out;
}

/**
 * Sales-invoice wording -> catalog code, for matching a client's list (shared/match.ts AliasMaps.si).
 * Only wordings asked for (`keys`, normalizeText of each line), last 12 months. A wording invoiced to
 * this client (customerNo) as exactly one code is `own`; otherwise the code it was invoiced as most
 * often, to anyone. A wording split evenly between codes says nothing and is left out.
 */
export async function salesNameMap(
  db: D1Database,
  entity: EntityKey,
  keys: string[],
  customerNo: string,
  now = new Date(),
): Promise<Map<string, { code: string; own: boolean }>> {
  const out = new Map<string, { code: string; own: boolean }>();
  const wanted = [...new Set(keys.filter(Boolean))];
  if (!wanted.length) return out;
  const since = new Date(now.getTime() - 365 * 86_400_000).toISOString().slice(0, 10);
  const rows = await all<{ name_key: string; item_code: string; own: number; n: number }>(
    db,
    `SELECT name_key, item_code, customer_no = ?4 AND ?4 <> '' AS own, COUNT(*) AS n
       FROM accurate_sales_lines
      WHERE entity = ?1 AND trans_date >= ?2 AND name_key IN (SELECT value FROM json_each(?3))
      GROUP BY name_key, item_code, own`,
    entity,
    since,
    JSON.stringify(wanted),
    customerNo,
  );
  const pick = (list: { item_code: string; n: number }[]) => {
    const counts = new Map<string, number>();
    for (const r of list) counts.set(r.item_code, (counts.get(r.item_code) ?? 0) + r.n);
    const sorted = [...counts].sort((a, b) => b[1] - a[1]);
    return sorted.length && (sorted.length === 1 || sorted[0][1] > sorted[1][1]) ? sorted[0][0] : undefined;
  };
  for (const key of wanted) {
    const mine = rows.filter((r) => r.name_key === key && r.own === 1);
    const ownCodes = new Set(mine.map((r) => r.item_code));
    if (ownCodes.size === 1) {
      out.set(key, { code: [...ownCodes][0], own: true });
      continue;
    }
    const code = pick(rows.filter((r) => r.name_key === key));
    if (code) out.set(key, { code, own: false });
  }
  return out;
}

/** SI lines per item code over the last 12 months, for ranking match candidates (shared/matchRank.ts). */
export async function soldCounts(db: D1Database, entity: EntityKey, codes: string[], now = new Date()): Promise<Map<string, number>> {
  if (!codes.length) return new Map();
  const since = new Date(now.getTime() - 365 * 86_400_000).toISOString().slice(0, 10);
  const rows = await all<{ item_code: string; n: number }>(
    db,
    `SELECT item_code, COUNT(*) AS n FROM accurate_sales_lines
      WHERE entity = ?1 AND trans_date >= ?2 AND item_code IN (SELECT value FROM json_each(?3))
      GROUP BY item_code`,
    entity,
    since,
    JSON.stringify([...new Set(codes)]),
  );
  return new Map(rows.map((r) => [r.item_code, r.n]));
}
