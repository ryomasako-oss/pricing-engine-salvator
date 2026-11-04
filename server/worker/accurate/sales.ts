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

import { get, run } from "../../db.d1";
import { SALES_LIST_FIELDS, mapSalesInvoice, mapSalesLines } from "./mapping";
import { docStep, receiptConfig, type DocKind, type ReceiptState } from "./receipts";
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
                customer_name, item_code, unit, unit_ratio, quantity, return_qty, sales_amount, inclusive_tax,
                tax_rate, cash_discount, sub_total, synced_at)
              SELECT ?1, json_extract(j.value, '$.invoiceId'), json_extract(j.value, '$.lineId'),
                     json_extract(j.value, '$.invoiceNo'), json_extract(j.value, '$.transDate'),
                     json_extract(j.value, '$.customerNo'), json_extract(j.value, '$.customerName'),
                     json_extract(j.value, '$.itemCode'), json_extract(j.value, '$.unit'),
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
