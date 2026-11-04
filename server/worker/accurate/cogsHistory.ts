/* ============================================================
   Riwayat COGS per barang, read-only: harga beli dari penerimaan barang
   (accurate_receipt_lines) dan nilai COGS katalog yang pernah diganti
   (catalog_cogs_history). Nothing here writes; COGS only changes through
   /apply-cogs. Cost data, so the route is guarded by view_costs.
   ============================================================ */

import { all, get } from "../../db.d1";
import { sameUom, unitFactor } from "../../../shared/uom";
import type { UnitFactor } from "../../../shared/types";
import { applyPurchaseCosts } from "./purchaseCost";
import type { EntityKey } from "./sync";

export const HISTORY_PAGE_SIZE = 20;
/** Newest receipts and COGS replacements shown on one card. */
const PER_CARD = 5;

export interface HistoryReceipt {
  receiptNo: string;
  transDate: string;
  unit: string;
  quantity: number;
  unitPrice: number;
  /** Price per catalog base unit, or null when the unit has no known ratio. */
  cost: number | null;
  /** The newest receipt whose cost equals the catalog COGS: the one the COGS most likely came from. */
  used: boolean;
}

export interface HistoryCard {
  code: string;
  name: string;
  uom: string;
  cogs: number;
  /** Set when the latest receipt differs from the catalog COGS; `held` says why apply-cogs would not write it by itself. */
  pending: { to: number; receiptNo: string; transDate: string; held: string | null } | null;
  receipts: HistoryReceipt[];
  /** Earlier COGS values, newest first; `at` is when that value was replaced. */
  changes: { cogs: number; at: string }[];
}

export interface HistoryPage {
  total: number;
  page: number;
  pageSize: number;
  cards: HistoryCard[];
}

export async function cogsHistory(
  db: D1Database,
  entity: EntityKey,
  opts: { q: string; onlyPending: boolean; page: number },
): Promise<HistoryPage> {
  const pending = new Map<string, HistoryCard["pending"]>();
  if (opts.onlyPending) {
    const r = await applyPurchaseCosts(db, entity, { dryRun: true });
    for (const c of r.changed) pending.set(c.code, { to: c.to, receiptNo: c.receiptNo, transDate: c.transDate, held: null });
    for (const c of r.held) pending.set(c.code, { to: c.to, receiptNo: c.receiptNo, transDate: c.transDate, held: c.reason });
  }
  const like = `%${opts.q.replace(/[\\%_]/g, "\\$&")}%`;
  const where = `(c.cogs > 0 OR c.code IN (SELECT item_code FROM accurate_receipt_lines WHERE entity = ?1))
                 AND (c.code LIKE ?2 ESCAPE '\\' OR c.name LIKE ?2 ESCAPE '\\')
                 AND (?3 = 0 OR c.code IN (SELECT value FROM json_each(?4)))`;
  const params = [entity, like, opts.onlyPending ? 1 : 0, JSON.stringify([...pending.keys()])] as const;

  const total = (await get<{ n: number }>(db, `SELECT COUNT(*) AS n FROM catalog_items c WHERE ${where}`, ...params))?.n ?? 0;
  const page = Math.max(1, opts.page);
  const items = await all<{ code: string; name: string; uom: string; cogs: number }>(
    db,
    `SELECT c.code, c.name, c.uom, c.cogs FROM catalog_items c WHERE ${where} ORDER BY c.code LIMIT ?5 OFFSET ?6`,
    ...params,
    HISTORY_PAGE_SIZE,
    (page - 1) * HISTORY_PAGE_SIZE,
  );
  const codes = JSON.stringify(items.map((i) => i.code));

  const receipts = await all<Omit<HistoryReceipt, "cost" | "used"> & { item_code: string }>(
    db,
    `SELECT item_code, receipt_no AS receiptNo, trans_date AS transDate, unit, quantity, unit_price AS unitPrice
       FROM (SELECT l.*, ROW_NUMBER() OVER (
                      PARTITION BY l.item_code ORDER BY l.trans_date DESC, l.receipt_id DESC, l.line_id DESC) AS rn
               FROM accurate_receipt_lines l
              WHERE l.entity = ?1 AND l.unit_price > 0 AND l.quantity > 0
                AND l.item_code IN (SELECT value FROM json_each(?2)))
      WHERE rn <= ${PER_CARD}
      ORDER BY item_code, rn`,
    entity,
    codes,
  );
  const changes = await all<{ code: string; cogs: number; at: string }>(
    db,
    `SELECT code, cogs, recorded_at AS at
       FROM (SELECT h.*, ROW_NUMBER() OVER (PARTITION BY h.code ORDER BY h.id DESC) AS rn
               FROM catalog_cogs_history h
              WHERE h.code IN (SELECT value FROM json_each(?1)))
      WHERE rn <= ${PER_CARD}
      ORDER BY code, rn`,
    codes,
  );

  const units = new Map(
    (await all<{ code: string; uom: string; units: string }>(
      db,
      `SELECT code, uom, units FROM accurate_items WHERE entity = ?1 AND code IN (SELECT value FROM json_each(?2))`,
      entity,
      codes,
    )).map((u) => [u.code, u]),
  );
  const parseUnits = (s: string): UnitFactor[] => {
    try {
      const v = JSON.parse(s);
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  };

  const cards = items.map((i): HistoryCard => {
    const a = units.get(i.code);
    const item = a && sameUom(i.uom, a.uom || "Pcs") ? { baseUom: a.uom || "Pcs", units: parseUnits(a.units) } : undefined;
    let found = false;
    const own = receipts
      .filter((r) => r.item_code === i.code)
      .map(({ item_code: _, ...r }): HistoryReceipt => {
        const factor = item && r.unit.trim() ? unitFactor(item, r.unit) : undefined;
        const cost = factor ? Math.round((r.unitPrice / factor) * 100) / 100 : null;
        const used = !found && cost !== null && i.cogs > 0 && Math.abs(cost - i.cogs) < 0.01;
        found ||= used;
        return { ...r, cost, used };
      });
    return {
      ...i,
      pending: pending.get(i.code) ?? null,
      receipts: own,
      changes: changes.filter((h) => h.code === i.code).map(({ cogs, at }) => ({ cogs, at })),
    };
  });
  return { total, page, pageSize: HISTORY_PAGE_SIZE, cards };
}
