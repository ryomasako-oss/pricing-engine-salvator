/* ============================================================
   /api/accurate — status, manual sync, data-quality flags, and the
   explicit promotion of one entity's Accurate data into the catalog.
   Read-only towards Accurate: nothing here writes back to Accurate.
   ============================================================ */

import { Hono } from "hono";
import { z } from "zod";
import { all, batch, get, stmt } from "../../db.d1";
import { audit } from "../audit";
import { requireAuth, requirePermission } from "../auth";
import { zodMessage } from "../../validate";
import { AccurateClient } from "../accurate/client";
import { ITEM_FIELDS } from "../accurate/mapping";
import {
  ENTITY_KEYS,
  catalogEntity,
  configuredEntities,
  credsFor,
  loadState,
  requestRestart,
  syncConfig,
  syncStep,
  type EntityKey,
} from "../accurate/sync";
import type { Env } from "../env";

export const accurateRouter = new Hono<Env>();
accurateRouter.use(requireAuth);

const entitySchema = z.enum(ENTITY_KEYS as [EntityKey, ...EntityKey[]]);

accurateRouter.get("/status", requirePermission("import_catalog"), async (c) => {
  const configured = configuredEntities(c.env);
  const entities = [];
  for (const e of ENTITY_KEYS) {
    const st = await loadState(c.env.DB, e);
    const counts = await get<{ items: number; priced: number; stock: number; warehouses: number }>(
      c.env.DB,
      `SELECT (SELECT COUNT(*) FROM accurate_items WHERE entity = ?1) AS items,
              (SELECT COUNT(*) FROM accurate_items WHERE entity = ?1 AND unit_price > 0) AS priced,
              (SELECT COUNT(*) FROM accurate_stock WHERE entity = ?1) AS stock,
              (SELECT COUNT(*) FROM accurate_warehouses WHERE entity = ?1) AS warehouses`,
      e,
    );
    entities.push({
      entity: e,
      configured: configured.includes(e),
      dbAlias: st.db_alias,
      phase: st.phase,
      page: st.page,
      warehouseIdx: st.warehouse_idx,
      itemsSeen: st.items_seen,
      stockRows: st.stock_rows,
      startedAt: st.started_at,
      lastSuccessAt: st.last_success_at,
      lastError: st.last_error,
      lastErrorAt: st.last_error_at,
      running: !!st.locked_until,
      ...counts,
    });
  }
  return c.json({
    hasSecret: !!c.env.ACCURATE_SIGNATURE_SECRET,
    config: syncConfig(c.env),
    catalogEntity: catalogEntity(c.env),
    entities,
  });
});

/** Starts a fresh run (restart: true) and/or advances the cursor for ~20 s. */
accurateRouter.post("/sync", requirePermission("import_catalog"), async (c) => {
  const parsed = z
    .object({ entity: entitySchema.optional(), restart: z.boolean().default(false) })
    .safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: zodMessage(parsed.error) }, 400);
  const targets = parsed.data.entity ? [parsed.data.entity] : configuredEntities(c.env);
  if (!targets.length) return c.json({ error: "Token Accurate belum dipasang di server." }, 400);

  const cfg = syncConfig(c.env);
  const results = [];
  for (const e of targets) {
    const creds = credsFor(c.env, e);
    if (!creds) {
      results.push({ entity: e, outcome: "error", error: `Token Accurate untuk ${e} belum dipasang.` });
      continue;
    }
    if (parsed.data.restart) await requestRestart(c.env.DB, e);
    results.push(
      await syncStep(c.env.DB, e, creds, { ...cfg, callsPerTick: Math.max(1, Math.floor(cfg.callsPerTick / targets.length)) }, {
        deadline: Date.now() + 20_000,
      }),
    );
  }
  const user = c.get("user")!;
  await audit(c.env.DB, user.id, "accurate", 0, "sync_requested", { targets, restart: parsed.data.restart });
  return c.json({ results });
});

/** Data-quality flags over the staged Accurate data. */
accurateRouter.get("/flags", requirePermission("import_catalog"), async (c) => {
  const limit = Math.min(500, Math.max(1, Number(c.req.query("limit")) || 50));
  const negativeStock = await all(
    c.env.DB,
    `SELECT s.entity, w.name AS warehouse, s.item_code AS code, i.name, s.quantity
       FROM accurate_stock s
       LEFT JOIN accurate_warehouses w ON w.entity = s.entity AND w.accurate_id = s.warehouse_id
       LEFT JOIN accurate_items i ON i.entity = s.entity AND i.code = s.item_code
      WHERE s.quantity < 0
      ORDER BY s.quantity ASC LIMIT ?`,
    limit,
  );
  const crossEntityMismatch = await all(
    c.env.DB,
    `SELECT cv.code, cv.name AS name_cv, pt.name AS name_pt,
            cv.unit_price AS price_cv, pt.unit_price AS price_pt, cv.uom AS uom_cv, pt.uom AS uom_pt
       FROM accurate_items cv
       JOIN accurate_items pt ON pt.code = cv.code AND pt.entity = 'PT'
      WHERE cv.entity = 'CV'
        AND (lower(trim(cv.name)) <> lower(trim(pt.name))
             OR abs(cv.unit_price - pt.unit_price) > 0.5
             OR lower(cv.uom) <> lower(pt.uom))
      ORDER BY cv.code LIMIT ?`,
    limit,
  );
  const sameNameDifferentCode = await all(
    c.env.DB,
    `SELECT lower(trim(name)) AS name_key, MIN(name) AS name, COUNT(DISTINCT code) AS codes,
            GROUP_CONCAT(DISTINCT entity || ':' || code) AS refs
       FROM accurate_items WHERE trim(name) <> ''
      GROUP BY lower(trim(name)) HAVING COUNT(DISTINCT code) > 1
      ORDER BY codes DESC LIMIT ?`,
    limit,
  );
  const counts = await get(
    c.env.DB,
    `SELECT (SELECT COUNT(*) FROM accurate_stock WHERE quantity < 0) AS negative_stock,
            (SELECT COUNT(*) FROM accurate_items cv JOIN accurate_items pt
                ON pt.code = cv.code AND pt.entity = 'PT' WHERE cv.entity = 'CV') AS overlapping_codes,
            (SELECT COUNT(*) FROM accurate_items cv JOIN accurate_items pt
                ON pt.code = cv.code AND pt.entity = 'PT' WHERE cv.entity = 'CV'
                 AND (lower(trim(cv.name)) <> lower(trim(pt.name))
                      OR abs(cv.unit_price - pt.unit_price) > 0.5
                      OR lower(cv.uom) <> lower(pt.uom))) AS cross_entity_mismatch,
            (SELECT COUNT(*) FROM (SELECT 1 FROM accurate_items WHERE trim(name) <> ''
                GROUP BY lower(trim(name)) HAVING COUNT(DISTINCT code) > 1)) AS same_name_different_code,
            (SELECT COUNT(*) FROM accurate_items WHERE unit_price <= 0 AND suspended = 0) AS no_selling_price`,
  );
  return c.json({ counts, negativeStock, crossEntityMismatch, sameNameDifferentCode });
});

/**
 * Promotes one entity's staged data into catalog_items, set-based (one
 * statement per table, so 30k rows don't become 30k D1 queries).
 * Same rules as the spreadsheet import: zero/empty never overwrites, COGS is
 * never touched (it still comes from the Nilai Persediaan report). Stock is
 * replaced with that entity's total across warehouses, but only from a
 * completed run: while a run is in progress, staging mixes rows this run has
 * re-read with rows from the last one.
 *
 * An item that already has a COGS keeps its base unit (and the price, stock
 * and unit ratios that are expressed in it) when Accurate reports a different
 * one: its COGS and COGS reference are per the old unit, and switching
 * "Pcs, COGS 100" to "Box of 24" would make every quote understate the cost
 * 24 times. Such items are listed for a manager to reconcile.
 */
accurateRouter.post("/apply", requirePermission("import_catalog"), async (c) => {
  const parsed = z
    .object({ entity: entitySchema, insertNew: z.boolean().default(false) })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: zodMessage(parsed.error) }, 400);
  const { entity, insertNew } = parsed.data;
  // Only one Data Usaha feeds the catalog: applying the other would overwrite
  // its prices and stock instead of adding to them.
  const target = catalogEntity(c.env);
  if (entity !== target) {
    return c.json(
      { error: `Katalog memakai data Accurate ${target}. Data ${entity} hanya untuk pengecekan, tidak diterapkan ke katalog.` },
      400,
    );
  }
  const st = await loadState(c.env.DB, entity);
  const staged = await get<{ n: number }>(c.env.DB, "SELECT COUNT(*) AS n FROM accurate_items WHERE entity = ?", entity);
  if (!staged?.n) return c.json({ error: `Belum ada data Accurate ${entity}. Jalankan sinkron dulu.` }, 409);

  const db = c.env.DB;
  const scope = `i.entity = ?1 AND i.suspended = 0 AND i.code <> ''
                 AND (?2 = 1 OR i.code IN (SELECT code FROM catalog_items))`;
  // Accurate's base unit differs from the catalog's for an item that has a COGS.
  const unitChanged = (c: string) =>
    `(${c}.cogs > 0 AND lower(trim(${c}.uom)) <> lower(trim(COALESCE(NULLIF(i.uom, ''), 'Pcs'))))`;
  const mismatched = await all<{ code: string }>(
    db,
    `SELECT i.code FROM accurate_items i JOIN catalog_items c ON c.code = i.code
      WHERE ${scope} AND ${unitChanged("c")} ORDER BY i.code`,
    entity,
    insertNew ? 1 : 0,
  );
  const upsertUnitChanged =
    "(catalog_items.cogs > 0 AND lower(trim(catalog_items.uom)) <> lower(trim(excluded.uom)))";
  // Stock only from a completed run, decided inside the batch (one transaction)
  // so a run that starts after these checks can't slip in before the write.
  const stockReady = `COALESCE((SELECT last_success_at IS NOT NULL AND phase = 'idle'
                                 FROM accurate_sync_state WHERE entity = ?1), 0) = 1`;
  const keepUnit = `NOT EXISTS (SELECT 1 FROM catalog_items c WHERE c.code = i.code AND ${unitChanged("c")})`;
  const [ready, upsert, , units] = await batch(db, [
    stmt(db, `SELECT ${stockReady} AS ok`, entity),
    stmt(
      db,
      `INSERT INTO catalog_items(code, name, uom, cogs, list_price, stock, category, source)
       SELECT i.code, i.name, COALESCE(NULLIF(i.uom, ''), 'Pcs'), 0, i.unit_price,
              COALESCE(s.qty, 0), i.category, 'accurate:' || i.entity
         FROM accurate_items i
         LEFT JOIN (SELECT item_code, SUM(quantity) AS qty FROM accurate_stock
                     WHERE entity = ?1 GROUP BY item_code) s ON s.item_code = i.code
        WHERE ${scope}
       ON CONFLICT(code) DO UPDATE SET
         name = CASE WHEN excluded.name <> '' THEN excluded.name ELSE catalog_items.name END,
         uom = CASE WHEN ${upsertUnitChanged} THEN catalog_items.uom
                    WHEN excluded.uom <> '' THEN excluded.uom ELSE catalog_items.uom END,
         list_price = CASE WHEN ${upsertUnitChanged} THEN catalog_items.list_price
                           WHEN excluded.list_price > 0 THEN excluded.list_price ELSE catalog_items.list_price END,
         stock = CASE WHEN ${stockReady} AND NOT ${upsertUnitChanged} THEN excluded.stock ELSE catalog_items.stock END,
         category = CASE WHEN excluded.category <> '' THEN excluded.category ELSE catalog_items.category END,
         source = excluded.source,
         updated_at = datetime('now')`,
      entity,
      insertNew ? 1 : 0,
    ),
    // Unit ratios: only replace an item's units when Accurate actually has some.
    stmt(
      db,
      `DELETE FROM catalog_item_uoms WHERE code IN (
         SELECT i.code FROM accurate_items i WHERE ${scope} AND i.units <> '[]' AND ${keepUnit})`,
      entity,
      insertNew ? 1 : 0,
    ),
    stmt(
      db,
      `INSERT OR REPLACE INTO catalog_item_uoms(code, uom, factor)
       SELECT i.code, json_extract(j.value, '$.uom'), json_extract(j.value, '$.factor')
         FROM accurate_items i, json_each(i.units) j
        WHERE ${scope} AND json_extract(j.value, '$.factor') > 0 AND ${keepUnit}`,
      entity,
      insertNew ? 1 : 0,
    ),
  ]);
  const result = {
    entity,
    insertNew,
    changed: upsert.meta.changes,
    unitRows: units.meta.changes,
    stockApplied: Boolean((ready.results[0] as { ok: number } | undefined)?.ok),
    // Kept on their catalog unit; a manager reconciles unit and COGS by hand.
    unitMismatch: mismatched.map((r) => r.code),
  };
  const user = c.get("user")!;
  await audit(db, user.id, "catalog", 0, "accurate_applied", result);
  return c.json(result);
});

/**
 * Admin-only connectivity check: resolves the host and returns two raw item
 * rows and one stock row, so field names can be verified against a real
 * database. Never returns the token or signature.
 */
accurateRouter.get("/probe", requirePermission("manage_company"), async (c) => {
  const parsed = entitySchema.safeParse(c.req.query("entity"));
  if (!parsed.success) return c.json({ error: "entity harus CV atau PT" }, 400);
  const creds = credsFor(c.env, parsed.data);
  if (!creds) return c.json({ error: `Token Accurate untuk ${parsed.data} belum dipasang.` }, 400);
  const client = new AccurateClient(creds);
  try {
    const info = await client.tokenInfo();
    const items = await client.raw("item/list.do", { fields: ITEM_FIELDS, "sp.page": 1, "sp.pageSize": 2 });
    const warehouses = await client.raw("warehouse/list.do", { fields: "id,name", "sp.page": 1, "sp.pageSize": 5 });
    const whId = ((warehouses as { d?: { id?: number }[] }).d ?? [])[0]?.id;
    const stock = whId
      ? await client.raw("item/list-stock.do", { warehouseId: whId, "sp.page": 1, "sp.pageSize": 2 })
      : null;
    return c.json({ host: info.host, alias: info.alias, items, warehouses, stock });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 502);
  }
});
