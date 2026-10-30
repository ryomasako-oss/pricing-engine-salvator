/* Barang baru otomatis (Ryoma, 2026-10-23): an item created in Accurate after
   the last manual "Terapkan" never reached the catalog until someone pressed
   it again and answered OK (103279 and 91 others were missing for 13 days).
   After every completed run the catalog's entity now adds the items it
   doesn't have yet, with the same values "Terapkan" would give them.

   Only inserts: an item already in the catalog is never touched here, so
   prices and units of existing items still change only through "Terapkan"
   (stock is refreshed separately, stock.ts). COGS starts at 0, which holds the item on every quote
   (cogsProblem: "COGS kosong di katalog") until a manager applies the
   purchase cost (purchaseCost.ts) or fills it in by hand. */

import { all, batch, stmt } from "../../db.d1";
import { CLOSE_LINKED_TASKS_SQL, LINK_PENDING_SQL } from "../../pendingItems";
import type { EntityKey } from "./sync";

/* Emptying the catalog on purpose (clear, or "ganti semua") pauses this until
   a manager presses "Terapkan" and answers OK to adding new items: otherwise
   the next completed run put back every Accurate item the file left out
   (about 7k) with COGS 0, holding every quote. Not time-based, because each
   later run would refill it the same way. */
export const PAUSE_NEW_ITEMS_SQL = `INSERT INTO settings(key, value)
  VALUES('accurate_new_items_paused', json_object('at', datetime('now'), 'by', ?))
  ON CONFLICT(key) DO UPDATE SET value = excluded.value`;
export const RESUME_NEW_ITEMS_SQL = "DELETE FROM settings WHERE key = 'accurate_new_items_paused'";

/** Codes listed in one audit entry; the count is always complete. */
export const AUDIT_CODES = 200;

export interface NewItemsResult {
  added: number;
  codes: string[];
}

/**
 * Adds the entity's active items the catalog lacks. Called from the cron
 * after a completed run (stock is then complete). One read, then one batch
 * of 5 statements: within the tick's 50-query budget next to the reconcile.
 */
export async function addNewItems(db: D1Database, entity: EntityKey): Promise<NewItemsResult> {
  const fresh = await all<{ code: string }>(
    db,
    `SELECT i.code FROM accurate_items i
      WHERE i.entity = ? AND i.suspended = 0 AND i.code <> ''
        -- An Accurate "abc-01" next to catalog "ABC-01" is the same item, not a new one (idx_catalog_code_nocase).
        AND NOT EXISTS (SELECT 1 FROM catalog_items c WHERE c.code = i.code COLLATE NOCASE)
        AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'accurate_new_items_paused')
      ORDER BY i.code`,
    entity,
  );
  if (!fresh.length) return { added: 0, codes: [] };
  const codes = JSON.stringify(fresh.map((r) => r.code));
  const [ins] = await batch(db, [
    stmt(
      db,
      `INSERT INTO catalog_items(code, name, uom, cogs, list_price, stock, category, source)
       SELECT i.code, i.name, COALESCE(NULLIF(i.uom, ''), 'Pcs'), 0, i.unit_price,
              COALESCE((SELECT SUM(s.quantity) FROM accurate_stock s WHERE s.entity = ?1 AND s.item_code = i.code), 0),
              i.category, 'accurate:' || i.entity
         FROM accurate_items i
        WHERE i.entity = ?1 AND i.code IN (SELECT value FROM json_each(?2))
       ON CONFLICT(code) DO NOTHING`,
      entity,
      codes,
    ),
    stmt(
      db,
      `INSERT OR IGNORE INTO catalog_item_uoms(code, uom, factor)
       SELECT i.code, json_extract(j.value, '$.uom'), json_extract(j.value, '$.factor')
         FROM accurate_items i, json_each(i.units) j
        WHERE i.entity = ?1 AND i.code IN (SELECT value FROM json_each(?2)) AND json_extract(j.value, '$.factor') > 0`,
      entity,
      codes,
    ),
    // "Barang baru" requests waiting for one of these codes are linked, as after "Terapkan".
    stmt(db, LINK_PENDING_SQL),
    stmt(db, CLOSE_LINKED_TASKS_SQL),
    stmt(
      db,
      "INSERT INTO audit_log(actor_id, entity, entity_id, action, detail) VALUES(NULL, 'catalog', 0, 'accurate_new_items', ?)",
      JSON.stringify({ entity, added: fresh.length, codes: fresh.slice(0, AUDIT_CODES).map((r) => r.code) }),
    ),
  ]);
  return { added: ins.meta.changes, codes: fresh.map((r) => r.code) };
}
