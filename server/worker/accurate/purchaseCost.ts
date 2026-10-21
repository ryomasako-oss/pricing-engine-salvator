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

   A change purchaseCostHold rejects (3x the selling price or more, or more than
   double / less than half the current COGS) is not written at all: it is
   reported as `held`, so a pack recorded as one PCS in an RI can't land in
   the catalog and become an empty item's reference (audit 16 Okt). The
   item's earlier receipts are a second reference (purchaseHistory): a
   correction that matches them lands even when the current COGS is the
   wrong one. A manager can still apply a held change after checking it
   (applyHeldCosts), which also makes it the reference.
   ============================================================ */

import { HISTORY_RECEIPTS, lastPurchaseCost, purchaseCostHold, purchaseHistory, type PurchaseCost, type ReceiptLine } from "../../../shared/lastPurchaseCost";
import type { UnitFactor } from "../../../shared/types";
import { all, batch, get, run, stmt } from "../../db.d1";
import type { EntityKey } from "./sync";

interface LineRow {
  code: string;
  name: string;
  catalog_uom: string;
  catalog_cogs: number;
  list_price: number;
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
  name: string;
  from: number;
  to: number;
  receiptNo: string;
  transDate: string;
}

export interface PurchaseCostHold extends PurchaseCostChange {
  listPrice: number;
  reason: string;
}

export interface PurchaseCostSkip {
  code: string;
  name: string;
  reason: "uom_mismatch" | "unknown_unit";
  detail: string;
}

export interface PurchaseCostResult {
  entity: EntityKey;
  dryRun: boolean;
  /** Catalog items with at least one priced receipt line. */
  withReceipt: number;
  changed: PurchaseCostChange[];
  /** Changes too far off to apply automatically (purchaseCostHold); the catalog keeps its COGS. */
  held: PurchaseCostHold[];
  unchanged: number;
  skipped: PurchaseCostSkip[];
  /** Catalog items with no priced receipt in the stored history; their COGS is left as it is. */
  noReceipt: number;
}

/**
 * Each catalog item's priced receipt lines from its latest HISTORY_RECEIPTS + 1 receipts (same order
 * as lastPurchaseCost), with its units: the latest receipt for the cost, the ones before it for
 * purchaseHistory. A receipt can list the item on several lines, hence DENSE_RANK.
 */
const LINES_SQL = `
  WITH ranked AS (
    SELECT l.*, DENSE_RANK() OVER (
             PARTITION BY l.item_code ORDER BY l.trans_date DESC, l.receipt_id DESC) AS rn
      FROM accurate_receipt_lines l
     WHERE l.entity = ?1 AND l.unit_price > 0 AND l.quantity > 0)
  SELECT c.code, c.name, c.uom AS catalog_uom, c.cogs AS catalog_cogs, c.list_price,
         COALESCE(NULLIF(i.uom, ''), 'Pcs') AS accurate_uom, i.units,
         r.receipt_id, r.line_id, r.receipt_no, r.trans_date, r.unit, r.quantity, r.unit_price
    FROM ranked r
    JOIN catalog_items c ON c.code = r.item_code
    JOIN accurate_items i ON i.entity = ?1 AND i.code = r.item_code
   WHERE r.rn <= ${HISTORY_RECEIPTS + 1}`;

const parseUnits = (s: string): UnitFactor[] => {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};

function describeSkip(code: string, r: Exclude<PurchaseCost, { ok: true } | { reason: "no_receipt" }>, row: LineRow): PurchaseCostSkip {
  return r.reason === "uom_mismatch"
    ? { code, name: row.name, reason: r.reason, detail: `Satuan katalog ${row.catalog_uom}, satuan dasar Accurate ${row.accurate_uom}` }
    : { code, name: row.name, reason: r.reason, detail: `${r.receiptNo} (${r.transDate}) memakai satuan "${r.unit}" tanpa rasio ke ${row.accurate_uom}` };
}

export async function applyPurchaseCosts(db: D1Database, entity: EntityKey, opts: { dryRun: boolean }): Promise<PurchaseCostResult> {
  const byCode = new Map<string, LineRow[]>();
  for (const row of await all<LineRow>(db, LINES_SQL, entity)) {
    const list = byCode.get(row.code);
    if (list) list.push(row);
    else byCode.set(row.code, [row]);
  }
  const changed: PurchaseCostChange[] = [];
  const held: PurchaseCostHold[] = [];
  const skipped: PurchaseCostSkip[] = [];
  let unchanged = 0;
  for (const code of [...byCode.keys()].sort((a, b) => a.localeCompare(b))) {
    const rows = byCode.get(code)!;
    const row = rows[0];
    const lines: ReceiptLine[] = rows.map((l) => ({
      receiptId: l.receipt_id, lineId: l.line_id, receiptNo: l.receipt_no, transDate: l.trans_date, unit: l.unit, quantity: l.quantity, unitPrice: l.unit_price,
    }));
    const item = { baseUom: row.accurate_uom, units: parseUnits(row.units) };
    const r = lastPurchaseCost(lines, item, row.catalog_uom);
    if (r.ok) {
      if (Math.abs(r.cost - row.catalog_cogs) < 0.005) unchanged++;
      else {
        const change = { code: row.code, name: row.name, from: row.catalog_cogs, to: r.cost, receiptNo: r.receiptNo, transDate: r.transDate };
        const reason = purchaseCostHold(row.catalog_cogs, r.cost, row.list_price, purchaseHistory(lines, item));
        if (reason) held.push({ ...change, listPrice: row.list_price, reason });
        else changed.push(change);
      }
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
    withReceipt: byCode.size,
    changed,
    held,
    unchanged,
    skipped,
    noReceipt: Math.max(0, (total?.n ?? 0) - byCode.size),
  };
}

export interface HeldApplyResult {
  applied: PurchaseCostHold[];
  /** Requested changes that are no longer held at the price the manager saw (RI edited, already applied, ...). */
  stale: { code: string; to: number }[];
}

/**
 * Applies held changes a manager checked, as the COGS and as its reference ("COGS ini benar" in
 * one step). The manager sends the price they saw; the held list is recomputed here and only a
 * code whose held price is still that one is written, so an RI edited in Accurate between the
 * preview and the click (103044, 15-19 Okt) is not applied unseen.
 */
export async function applyHeldCosts(
  db: D1Database,
  entity: EntityKey,
  actorId: number,
  picks: { code: string; to: number }[],
): Promise<HeldApplyResult> {
  const { held } = await applyPurchaseCosts(db, entity, { dryRun: true });
  const byCode = new Map(held.map((h) => [h.code, h]));
  const applied: PurchaseCostHold[] = [];
  const stale: HeldApplyResult["stale"] = [];
  for (const p of picks) {
    const h = byCode.get(p.code);
    if (h && Math.abs(h.to - p.to) < 0.005) applied.push(h);
    else stale.push(p);
  }
  if (applied.length) {
    const json = JSON.stringify(applied.map((h) => ({ code: h.code, from: h.from, to: h.to, receiptNo: h.receiptNo, transDate: h.transDate, reason: h.reason })));
    // One transaction. The 0010 trigger records the old COGS in the history; the baseline then
    // moves like verify-cogs (VERIFY_COGS_SQL) does.
    await batch(db, [
      stmt(
        db,
        `UPDATE catalog_items
            SET cogs = (SELECT json_extract(j.value, '$.to') FROM json_each(?1) j
                         WHERE json_extract(j.value, '$.code') = catalog_items.code),
                updated_at = datetime('now')
          WHERE code IN (SELECT json_extract(value, '$.code') FROM json_each(?1))`,
        json,
      ),
      stmt(
        db,
        `INSERT INTO catalog_cogs_baseline(code, cogs)
         SELECT json_extract(value, '$.code'), json_extract(value, '$.to') FROM json_each(?1) WHERE true
         ON CONFLICT(code) DO UPDATE SET cogs = excluded.cogs`,
        json,
      ),
      stmt(
        db,
        `INSERT INTO audit_log(actor_id, entity, entity_id, action, detail)
         SELECT ?2, 'catalog', c.id, 'cogs_held_applied', json_set(j.value, '$.entity', ?3)
           FROM json_each(?1) j JOIN catalog_items c ON c.code = json_extract(j.value, '$.code')`,
        json,
        actorId,
        entity,
      ),
    ]);
  }
  return { applied, stale };
}
