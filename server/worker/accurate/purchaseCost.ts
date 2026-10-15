/* ============================================================
   Catalog COGS from Accurate goods receipts: COGS = harga pembelian
   terakhir (shared/lastPurchaseCost.ts). Run on demand (POST
   /api/accurate/apply-cogs), never per cron tick: it reads every stored
   receipt line once.

   Writing catalog_items.cogs keeps the existing safety net: the 0010
   trigger records history without moving the reference, and cogsCheck
   holds quote lines whose COGS jumped far from that reference until a
   manager confirms ("COGS ini benar"). So a large change still needs a
   manager; a small one lands like a spreadsheet import did.
   ============================================================ */

import { lastPurchaseCost, type PurchaseCost } from "../../../shared/lastPurchaseCost";
import type { UnitFactor } from "../../../shared/types";
import { all, get, run } from "../../db.d1";
import type { EntityKey } from "./sync";

interface LatestRow {
  code: string;
  catalog_uom: string;
  catalog_cogs: number;
  accurate_uom: string;
  units: string;
  receipt_id: number;
  line_id: number;
  receipt_no: string;
  trans_date: string;
  unit: string;
  quantity: number;
  unit_price: number;
}

export interface PurchaseCostChange {
  code: string;
  from: number;
  to: number;
  receiptNo: string;
  transDate: string;
}

export interface PurchaseCostSkip {
  code: string;
  reason: "uom_mismatch" | "unknown_unit";
  detail: string;
}

export interface PurchaseCostResult {
  entity: EntityKey;
  dryRun: boolean;
  /** Catalog items with at least one priced receipt line. */
  withReceipt: number;
  changed: PurchaseCostChange[];
  unchanged: number;
  skipped: PurchaseCostSkip[];
  /** Catalog items with no priced receipt in the stored history; their COGS is left as it is. */
  noReceipt: number;
}

/** Each catalog item's latest priced receipt line (same order as lastPurchaseCost), with its units. */
const LATEST_SQL = `
  WITH ranked AS (
    SELECT l.*, ROW_NUMBER() OVER (
             PARTITION BY l.item_code ORDER BY l.trans_date DESC, l.receipt_id DESC, l.line_id DESC) AS rn
      FROM accurate_receipt_lines l
     WHERE l.entity = ?1 AND l.unit_price > 0 AND l.quantity > 0)
  SELECT c.code, c.uom AS catalog_uom, c.cogs AS catalog_cogs,
         COALESCE(NULLIF(i.uom, ''), 'Pcs') AS accurate_uom, i.units,
         r.receipt_id, r.line_id, r.receipt_no, r.trans_date, r.unit, r.quantity, r.unit_price
    FROM ranked r
    JOIN catalog_items c ON c.code = r.item_code
    JOIN accurate_items i ON i.entity = ?1 AND i.code = r.item_code
   WHERE r.rn = 1`;

const parseUnits = (s: string): UnitFactor[] => {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};

function describeSkip(code: string, r: Exclude<PurchaseCost, { ok: true } | { reason: "no_receipt" }>, row: LatestRow): PurchaseCostSkip {
  return r.reason === "uom_mismatch"
    ? { code, reason: r.reason, detail: `Satuan katalog ${row.catalog_uom}, satuan dasar Accurate ${row.accurate_uom}` }
    : { code, reason: r.reason, detail: `${r.receiptNo} (${r.transDate}) memakai satuan "${r.unit}" tanpa rasio ke ${row.accurate_uom}` };
}

export async function applyPurchaseCosts(db: D1Database, entity: EntityKey, opts: { dryRun: boolean }): Promise<PurchaseCostResult> {
  const rows = await all<LatestRow>(db, LATEST_SQL, entity);
  const changed: PurchaseCostChange[] = [];
  const skipped: PurchaseCostSkip[] = [];
  let unchanged = 0;
  for (const row of rows) {
    const r = lastPurchaseCost(
      [{ receiptId: row.receipt_id, lineId: row.line_id, receiptNo: row.receipt_no, transDate: row.trans_date, unit: row.unit, quantity: row.quantity, unitPrice: row.unit_price }],
      { baseUom: row.accurate_uom, units: parseUnits(row.units) },
      row.catalog_uom,
    );
    if (r.ok) {
      if (Math.abs(r.cost - row.catalog_cogs) < 0.005) unchanged++;
      else changed.push({ code: row.code, from: row.catalog_cogs, to: r.cost, receiptNo: r.receiptNo, transDate: r.transDate });
    } else if (r.reason !== "no_receipt") {
      skipped.push(describeSkip(row.code, r, row));
    }
  }
  const total = await get<{ n: number }>(db, "SELECT COUNT(*) AS n FROM catalog_items");

  if (!opts.dryRun && changed.length) {
    // One statement: D1 bills every statement of a batch. The cogs triggers fire per row.
    await run(
      db,
      `UPDATE catalog_items
          SET cogs = (SELECT json_extract(j.value, '$.to') FROM json_each(?1) j
                       WHERE json_extract(j.value, '$.code') = catalog_items.code),
              updated_at = datetime('now')
        WHERE code IN (SELECT json_extract(value, '$.code') FROM json_each(?1))`,
      JSON.stringify(changed.map((c) => ({ code: c.code, to: c.to }))),
    );
  }
  return {
    entity,
    dryRun: opts.dryRun,
    withReceipt: rows.length,
    changed,
    unchanged,
    skipped,
    noReceipt: Math.max(0, (total?.n ?? 0) - rows.length),
  };
}
