/* Stok otomatis (Ryoma, 2026-10-30): the catalog's stock only changed when a
   manager pressed "Terapkan", so quotes showed stock days old while the cron
   already had fresh totals in accurate_stock. After every completed run the
   catalog's entity now copies each item's total across warehouses, and
   records which run it came from so the UI can say "posisi per …".

   Stock only: prices, units and COGS still change only through "Terapkan".
   An item whose catalog unit differs from Accurate's is skipped, because the
   quantity is counted in Accurate's unit (same rule as "Terapkan"). */

import { batch, stmt } from "../../db.d1";
import type { EntityKey } from "./sync";

export const STOCK_AS_OF_KEY = "accurate_stock_as_of";

/** Called from the cron after a completed run. One batch of 2 statements. */
export async function refreshStock(db: D1Database, entity: EntityKey): Promise<number> {
  const [upd] = await batch(db, [
    stmt(
      db,
      `UPDATE catalog_items SET stock = s.qty
         FROM (SELECT i.code, COALESCE(NULLIF(i.uom, ''), 'Pcs') AS uom,
                      COALESCE((SELECT SUM(q.quantity) FROM accurate_stock q
                                 WHERE q.entity = ?1 AND q.item_code = i.code), 0) AS qty
                 FROM accurate_items i
                WHERE i.entity = ?1 AND i.suspended = 0 AND i.code <> '') s
        WHERE catalog_items.code = s.code COLLATE NOCASE
          AND lower(trim(catalog_items.uom)) = lower(trim(s.uom))
          AND catalog_items.stock IS NOT s.qty`,
      entity,
    ),
    stmt(
      db,
      `INSERT INTO settings(key, value)
       SELECT ?2, last_success_at FROM accurate_sync_state WHERE entity = ?1 AND last_success_at IS NOT NULL
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      entity,
      STOCK_AS_OF_KEY,
    ),
  ]);
  return upd.meta.changes;
}
