/* ============================================================
   /api/accurate — status, manual sync, data-quality flags, and the
   explicit promotion of one entity's Accurate data into the catalog.
   Read-only towards Accurate: nothing here writes back to Accurate.
   ============================================================ */

import { COUNTS_TTL_MS, FLAGS_TTL_MS, cachedFor } from "../accurate/cache";
import { Hono } from "hono";
import { z } from "zod";
import { all, batch, get, stmt } from "../../db.d1";
import { audit } from "../audit";
import { requireAuth, requirePermission } from "../auth";
import { hasPermission } from "../../../shared/permissions";
import { zodMessage } from "../../validate";
import { AccurateClient } from "../accurate/client";
import { ITEM_FIELDS, RECEIPT_LIST_FIELDS } from "../accurate/mapping";
import { applyHeldCosts, applyPurchaseCosts } from "../accurate/purchaseCost";
import { loadReceiptState, receiptsEnabled, wibTimestamp } from "../accurate/receipts";
import { sweepPending } from "./pendingItems";
import { RESUME_NEW_ITEMS_SQL } from "../accurate/newItems";
import { reconcileCounts, reconcileExamples, runReconcile } from "../accurate/reconcile";
import { CHECKS, CHECK_KEYS, isCheckKey } from "../../../shared/accurateReconcile";
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
  const fresh = c.req.query("fresh") === "1";
  const entities = [];
  for (const e of ENTITY_KEYS) {
    const st = await loadState(c.env.DB, e);
    // Recounting 7,000+ items on every poll is what exhausted D1's daily read allowance (see cache.ts).
    const counts = await cachedFor(
      c.env.DB,
      `cache:accurate:counts:${e}`,
      COUNTS_TTL_MS,
      () =>
        get<{ items: number; priced: number; stock: number; warehouses: number }>(
          c.env.DB,
          `SELECT (SELECT COUNT(*) FROM accurate_items WHERE entity = ?1) AS items,
                  (SELECT COUNT(*) FROM accurate_items WHERE entity = ?1 AND unit_price > 0) AS priced,
                  (SELECT COUNT(*) FROM accurate_stock WHERE entity = ?1) AS stock,
                  (SELECT COUNT(*) FROM accurate_warehouses WHERE entity = ?1) AS warehouses`,
          e,
        ),
      { fresh },
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
  const payload = await cachedFor(
    c.env.DB,
    `cache:accurate:flags:${limit}`,
    FLAGS_TTL_MS,
    () => computeFlags(c.env.DB, limit),
    { fresh: c.req.query("fresh") === "1" },
  );
  return c.json(payload);
});

async function computeFlags(db: D1Database, limit: number) {
  const negativeStock = await all(
    db,
    `SELECT s.entity, w.name AS warehouse, s.item_code AS code, i.name, s.quantity
       FROM accurate_stock s
       LEFT JOIN accurate_warehouses w ON w.entity = s.entity AND w.accurate_id = s.warehouse_id
       LEFT JOIN accurate_items i ON i.entity = s.entity AND i.code = s.item_code
      WHERE s.quantity < 0
      ORDER BY s.quantity ASC LIMIT ?`,
    limit,
  );
  // The cross-entity checks compare CV with PT. With no CV rows (the usual case here) they are empty,
  // so skip two joins over the whole table.
  const hasCv = !!(await get(db, "SELECT 1 AS x FROM accurate_items WHERE entity = 'CV' LIMIT 1"));
  const crossEntityMismatch = !hasCv ? [] : await all(
    db,
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
    db,
    `SELECT lower(trim(name)) AS name_key, MIN(name) AS name, COUNT(DISTINCT code) AS codes,
            GROUP_CONCAT(DISTINCT entity || ':' || code) AS refs
       FROM accurate_items WHERE trim(name) <> ''
      GROUP BY lower(trim(name)) HAVING COUNT(DISTINCT code) > 1
      ORDER BY codes DESC LIMIT ?`,
    limit,
  );
  const counts = await get(
    db,
    `SELECT (SELECT COUNT(*) FROM accurate_stock WHERE quantity < 0) AS negative_stock,
            ${
              hasCv
                ? `(SELECT COUNT(*) FROM accurate_items cv JOIN accurate_items pt
                ON pt.code = cv.code AND pt.entity = 'PT' WHERE cv.entity = 'CV') AS overlapping_codes,
            (SELECT COUNT(*) FROM accurate_items cv JOIN accurate_items pt
                ON pt.code = cv.code AND pt.entity = 'PT' WHERE cv.entity = 'CV'
                 AND (lower(trim(cv.name)) <> lower(trim(pt.name))
                      OR abs(cv.unit_price - pt.unit_price) > 0.5
                      OR lower(cv.uom) <> lower(pt.uom))) AS cross_entity_mismatch,`
                : "0 AS overlapping_codes, 0 AS cross_entity_mismatch,"
            }
            (SELECT COUNT(*) FROM (SELECT 1 FROM accurate_items WHERE trim(name) <> ''
                GROUP BY lower(trim(name)) HAVING COUNT(DISTINCT code) > 1)) AS same_name_different_code,
            (SELECT COUNT(*) FROM accurate_items WHERE unit_price <= 0 AND suspended = 0) AS no_selling_price`,
  );
  return { counts, negativeStock, crossEntityMismatch, sameNameDifferentCode };
}

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
  // A new item is inserted only when no catalog code matches it ignoring case (newItems.ts does the same).
  const scope = `i.entity = ?1 AND i.suspended = 0 AND i.code <> ''
                 AND (i.code IN (SELECT code FROM catalog_items)
                      OR (?2 = 1 AND NOT EXISTS (SELECT 1 FROM catalog_items c WHERE c.code = i.code COLLATE NOCASE)))`;
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
  // Stock only from a completed run, for inserted and updated items alike, decided
  // inside the batch (one transaction) so a run that starts after these checks
  // can't slip in before the write.
  const stockReady = `COALESCE((SELECT last_success_at IS NOT NULL AND phase = 'idle'
                                 FROM accurate_sync_state WHERE entity = ?1), 0) = 1`;
  const keepUnit = `NOT EXISTS (SELECT 1 FROM catalog_items c WHERE c.code = i.code AND ${unitChanged("c")})`;
  const [ready, upsert, , units] = await batch(db, [
    stmt(db, `SELECT ${stockReady} AS ok`, entity),
    stmt(
      db,
      `INSERT INTO catalog_items(code, name, uom, cogs, list_price, stock, category, source)
       SELECT i.code, i.name, COALESCE(NULLIF(i.uom, ''), 'Pcs'), 0, i.unit_price,
              CASE WHEN ${stockReady} THEN COALESCE(s.qty, 0) ELSE 0 END, i.category, 'accurate:' || i.entity
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
    // Answering OK to new items is the explicit go-ahead after a clear/replace paused them (newItems.ts).
    ...(insertNew ? [stmt(db, RESUME_NEW_ITEMS_SQL)] : []),
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
  // Barang baru requests whose code arrived in the catalog with this apply are linked now.
  await sweepPending(db);
  return c.json(result);
});

/**
 * Where collecting goods receipts stands, for the "COGS dari pembelian terakhir" panel.
 * One row read (accurate_receipt_state); the panel polls it while a pass runs.
 */
accurateRouter.get("/receipts", requirePermission("import_catalog"), requirePermission("view_costs"), async (c) => {
  const entity = catalogEntity(c.env);
  const st = await loadReceiptState(c.env.DB, entity);
  return c.json({
    entity,
    enabled: receiptsEnabled(c.env),
    inProgress: !!st.pass_started_at,
    receiptsSeen: st.receipts_seen,
    lastPassAt: st.last_pass_at,
    through: st.since_update,
    since: st.backfill_since,
    lastError: st.last_error,
    lastErrorAt: st.last_error_at,
  });
});

/**
 * COGS = harga pembelian terakhir: sets each catalog item's COGS to the unit
 * price of its latest Accurate goods receipt (server/worker/accurate/purchaseCost.ts).
 * `dryRun` (default) only reports what would change. Separate from /apply,
 * which never touches COGS. Purchase prices are cost data, hence view_costs.
 */
accurateRouter.post("/apply-cogs", requirePermission("import_catalog"), requirePermission("view_costs"), async (c) => {
  const parsed = z.object({ dryRun: z.boolean().default(true) }).safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: zodMessage(parsed.error) }, 400);
  // Writing COGS takes what the other COGS writes take (verify-cogs, apply-held-cogs, PUT /catalog/:id); the preview doesn't.
  if (!parsed.data.dryRun && !hasPermission(c.get("user")!.role, "edit_catalog")) {
    return c.json({ error: "Akses ditolak untuk peran Anda." }, 403);
  }
  const entity = catalogEntity(c.env);
  const st = await loadReceiptState(c.env.DB, entity);
  if (!st.last_pass_at) {
    return c.json({ error: `Riwayat penerimaan barang Accurate ${entity} belum lengkap. Tunggu satu putaran sinkron penerimaan selesai.` }, 409);
  }
  const result = await applyPurchaseCosts(c.env.DB, entity, { dryRun: parsed.data.dryRun });
  if (!result.dryRun) {
    await audit(c.env.DB, c.get("user")!.id, "catalog", 0, "cogs_from_purchases", {
      entity,
      changed: result.changed.length,
      held: result.held.length,
      unchanged: result.unchanged,
      skipped: result.skipped.length,
      noReceipt: result.noReceipt,
      receiptsThrough: st.since_update,
    });
  }
  return c.json({ ...result, receipts: { lastPassAt: st.last_pass_at, through: st.since_update, inProgress: !!st.pass_started_at } });
});

/**
 * Applies changes apply-cogs held back, for the codes a manager checked, at the price they saw.
 * It moves the COGS reference too, so it takes what verify-cogs takes (edit_catalog) on top of
 * what apply-cogs takes.
 */
accurateRouter.post(
  "/apply-held-cogs",
  requirePermission("import_catalog"),
  requirePermission("view_costs"),
  requirePermission("edit_catalog"),
  async (c) => {
    const parsed = z
      .object({ items: z.array(z.object({ code: z.string().min(1), to: z.number().positive() })).min(1).max(500) })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: zodMessage(parsed.error) }, 400);
    const entity = catalogEntity(c.env);
    const st = await loadReceiptState(c.env.DB, entity);
    if (!st.last_pass_at) {
      return c.json({ error: `Riwayat penerimaan barang Accurate ${entity} belum lengkap. Tunggu satu putaran sinkron penerimaan selesai.` }, 409);
    }
    return c.json(await applyHeldCosts(c.env.DB, entity, c.get("user")!.id, parsed.data.items));
  },
);

/** Where the catalog's Accurate cross-check stands: the staged data of the catalog entity must be a completed run. */
async function reconcileState(db: D1Database, entity: EntityKey) {
  const st = await loadState(db, entity);
  const staged = await get<{ n: number }>(db, "SELECT COUNT(*) AS n FROM accurate_items WHERE entity = ?", entity);
  return { staged: staged?.n ?? 0, complete: st.phase === "idle" && !!st.last_success_at, lastRunAt: st.last_success_at, checkedAt: st.reconciled_at };
}

/**
 * Cross-check of the catalog against Accurate (shared/accurateReconcile.ts):
 * live counts per kind of mismatch. Accurate is the starting reference, not
 * the truth, so this lists where the two disagree for a manager to judge.
 * The rows and task texts show catalog COGS, so these routes also ask for
 * view_costs rather than rely on every import_catalog role having it.
 */
accurateRouter.get("/reconcile", requirePermission("import_catalog"), requirePermission("view_costs"), async (c) => {
  const entity = catalogEntity(c.env);
  const state = await reconcileState(c.env.DB, entity);
  if (!state.staged) return c.json({ entity, ready: false, ...state, checks: [] });
  const counts = await reconcileCounts(c.env.DB, entity);
  return c.json({
    entity,
    ready: true,
    ...state,
    checks: CHECK_KEYS.map((key) => ({ key, label: CHECKS[key].label, todo: CHECKS[key].todo, notify: CHECKS[key].notify, count: counts[key] })),
  });
});

accurateRouter.get("/reconcile/:key", requirePermission("import_catalog"), requirePermission("view_costs"), async (c) => {
  const key = c.req.param("key") ?? "";
  if (!isCheckKey(key)) return c.json({ error: "Jenis pengecekan tidak dikenal." }, 404);
  const limit = Math.min(500, Math.max(1, Number(c.req.query("limit")) || 100));
  return c.json({ key, rows: await reconcileExamples(c.env.DB, catalogEntity(c.env), key, limit) });
});

/** Runs the check now and refreshes the "Perlu diperbaiki" tasks (the cron does the same after every completed run). */
accurateRouter.post("/reconcile", requirePermission("import_catalog"), requirePermission("view_costs"), async (c) => {
  const entity = catalogEntity(c.env);
  const state = await reconcileState(c.env.DB, entity);
  if (!state.staged || !state.complete) {
    return c.json({ error: `Belum ada sinkron Accurate ${entity} yang selesai. Jalankan sinkron dulu.` }, 409);
  }
  const result = await runReconcile(c.env.DB, entity);
  await audit(c.env.DB, c.get("user")!.id, "accurate", 0, "reconciled", { entity, counts: result.counts, open: result.open, closed: result.closed });
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
    // Goods receipts (COGS = harga pembelian terakhir): one listed row and one detail, or the
    // detail of ?receipt=<nomor RI> to compare its unit price with Accurate's Mutasi tab.
    // The two row counts show whether Accurate honours the lastUpdate filter the receipts sync relies
    // on: if it were ignored, every pass would re-read the whole history, one call per receipt.
    let receipts: unknown = null;
    let receiptDetail: unknown = null;
    let receiptFilterCheck: unknown = null;
    if (receiptsEnabled(c.env) || c.req.query("receipts") === "1" || c.req.query("receipt")) {
      receipts = await client.raw("receive-item/list.do", { fields: RECEIPT_LIST_FIELDS, "sp.page": 1, "sp.pageSize": 1, "sp.sort": "id|desc" });
      const yesterday = wibTimestamp(new Date(Date.now() - 86_400_000));
      const recent = await client.raw("receive-item/list.do", {
        fields: "id", "sp.page": 1, "sp.pageSize": 1,
        "filter.lastUpdate.op": "GREATER_EQUAL_THAN", "filter.lastUpdate.val": yesterday,
      });
      const rowCount = (b: unknown) => (b as { sp?: { rowCount?: number } }).sp?.rowCount ?? null;
      receiptFilterCheck = { all: rowCount(receipts), updatedSince: yesterday, updatedRecently: rowCount(recent) };
      const number = c.req.query("receipt");
      const firstId = ((receipts as { d?: { id?: number }[] }).d ?? [])[0]?.id;
      receiptDetail = number
        ? await client.raw("receive-item/detail.do", { number })
        : firstId
          ? await client.raw("receive-item/detail.do", { id: firstId })
          : null;
    }
    // Sales invoices (2026-10-17): what the sales team actually sold, per customer, under the
    // item code and the name typed on the invoice — the history product familiarity would learn
    // from. Read only on ?sales=1 or ?invoice=<nomor>. Each call reports its own error: the
    // token may not carry the sales-invoice scope, and that answer is itself what this checks.
    let sales: unknown = null;
    if (c.req.query("sales") === "1" || c.req.query("invoice")) {
      const attempt = async (f: () => Promise<unknown>) => {
        try {
          return await f();
        } catch (err) {
          return { error: (err as Error).message };
        }
      };
      const rowCount = (b: unknown) => (b as { sp?: { rowCount?: number } }).sp?.rowCount ?? null;
      const list = await attempt(() =>
        client.raw("sales-invoice/list.do", { fields: "id,number,transDate,customer,lastUpdate", "sp.page": 1, "sp.pageSize": 1, "sp.sort": "id|desc" }),
      );
      const yesterday = wibTimestamp(new Date(Date.now() - 86_400_000));
      const recent = await attempt(() =>
        client.raw("sales-invoice/list.do", {
          fields: "id", "sp.page": 1, "sp.pageSize": 1,
          "filter.lastUpdate.op": "GREATER_EQUAL_THAN", "filter.lastUpdate.val": yesterday,
        }),
      );
      const number = c.req.query("invoice");
      const firstId = ((list as { d?: { id?: number }[] }).d ?? [])[0]?.id;
      const detail = number
        ? await attempt(() => client.raw("sales-invoice/detail.do", { number }))
        : firstId
          ? await attempt(() => client.raw("sales-invoice/detail.do", { id: firstId }))
          : null;
      sales = { list, filterCheck: { all: rowCount(list), updatedSince: yesterday, updatedRecently: rowCount(recent) }, detail };
    }
    return c.json({ host: info.host, alias: info.alias, items, warehouses, stock, receipts, receiptFilterCheck, receiptDetail, sales });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 502);
  }
});
