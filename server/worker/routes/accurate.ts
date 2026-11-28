/* ============================================================
   /api/accurate — status, manual sync, data-quality flags, and the
   explicit promotion of one entity's Accurate data into the catalog.
   Read-only towards Accurate: nothing here writes back to Accurate.
   ============================================================ */

import { COUNTS_TTL_MS, FLAGS_TTL_MS, cachedFor } from "../accurate/cache";
import { Hono } from "hono";
import { z } from "zod";
import { all, batch, get, run, stmt } from "../../db.d1";
import { audit } from "../audit";
import { requireAuth, requirePermission } from "../auth";
import { hasPermission } from "../../../shared/permissions";
import { zodMessage } from "../../validate";
import { AccurateClient } from "../accurate/client";
import { ITEM_FIELDS, RECEIPT_LIST_FIELDS, mapPurchaseLines } from "../accurate/mapping";
import { cogsHistory } from "../accurate/cogsHistory";
import { purchaseHistory } from "../accurate/purchaseHistory";
import { salesHistory } from "../accurate/salesHistory";
import { lastSales, salesBelowCostBetween, salesBelowCostOfInvoice, salesEnabled } from "../accurate/sales";
import { belowCostDedupe, type BelowCostTask } from "../../../shared/fixTasks";
import { applyHeldCosts, applyPurchaseCosts } from "../accurate/purchaseCost";
import { costKind, costLines, loadReceiptState, purchasesEnabled, receiptsEnabled, wibTimestamp } from "../accurate/receipts";
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
      { error: `Katalog memakai data Accurate ${target}. Data ${entity} hanya untuk dicek, tidak masuk ke katalog.` },
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
  // Stok (2026-11-20): an item with an ACCed change not yet sent to Accurate keeps its stock, and each stock
  // that does change leaves a stock_history row, written before the upsert while the old value is still there.
  const notUnsent = (c: string) => `NOT EXISTS (SELECT 1 FROM stock_unsent u WHERE u.code = ${c}.code)`;
  const [ready, , upsert, , units] = await batch(db, [
    stmt(db, `SELECT ${stockReady} AS ok`, entity),
    stmt(
      db,
      `INSERT INTO stock_history(code, uom, qty_before, qty_after, source, filled_by)
       SELECT c.code, COALESCE(NULLIF(i.uom, ''), 'Pcs'), c.stock, COALESCE(s.qty, 0), 'apply', ?3
         FROM accurate_items i
         JOIN catalog_items c ON c.code = i.code
         LEFT JOIN (SELECT item_code, SUM(quantity) AS qty FROM accurate_stock
                     WHERE entity = ?1 GROUP BY item_code) s ON s.item_code = i.code
        WHERE ${scope} AND ${stockReady} AND NOT ${unitChanged("c")} AND ${notUnsent("c")}
          AND c.stock IS NOT COALESCE(s.qty, 0)`,
      entity,
      insertNew ? 1 : 0,
      c.get("user")!.id,
    ),
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
         stock = CASE WHEN ${stockReady} AND NOT ${upsertUnitChanged}
                       AND NOT EXISTS (SELECT 1 FROM stock_unsent u WHERE u.code = catalog_items.code)
                      THEN excluded.stock ELSE catalog_items.stock END,
         category = CASE WHEN excluded.category <> '' THEN excluded.category ELSE catalog_items.category END,
         source = excluded.source,
         updated_at = datetime('now')`,
      entity,
      insertNew ? 1 : 0,
    ),
    // Unit ratios: only replace an item's units when Accurate actually has some. Units added by hand
    // in the app (manual = 1, e.g. Pcs under a Lusin item, by warehouse staff) stay.
    stmt(
      db,
      `DELETE FROM catalog_item_uoms WHERE manual = 0 AND code IN (
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
  const st = await loadReceiptState(c.env.DB, entity, costKind(c.env));
  return c.json({
    entity,
    enabled: c.env.ACCURATE_COGS_SOURCE === "PI" ? purchasesEnabled(c.env) : receiptsEnabled(c.env),
    source: costKind(c.env).path,
    inProgress: !!st.pass_started_at,
    receiptsSeen: st.receipts_seen,
    lastPassAt: st.last_pass_at,
    through: st.since_update,
    since: st.backfill_since,
    lastError: st.last_error,
    lastErrorAt: st.last_error_at,
  });
});

/** Riwayat COGS per barang (read-only). Purchase prices are cost data, hence view_costs. */
accurateRouter.get("/cogs-history", requirePermission("view_costs"), async (c) => {
  const page = Number(c.req.query("page"));
  return c.json(
    await cogsHistory(c.env.DB, catalogEntity(c.env), {
      q: (c.req.query("q") ?? "").trim().slice(0, 100),
      onlyPending: c.req.query("pending") === "1",
      page: Number.isInteger(page) && page > 0 ? page : 1,
      lines: costLines(c.env),
    }),
  );
});

/** Riwayat penjualan (SI) per barang (read-only), for checking a match against what was sold. Gated like Riwayat COGS. */
accurateRouter.get("/sales-history", requirePermission("view_costs"), async (c) => {
  const page = Number(c.req.query("page"));
  return c.json(
    await salesHistory(c.env.DB, catalogEntity(c.env), {
      q: (c.req.query("q") ?? "").trim().slice(0, 100),
      page: Number.isInteger(page) && page > 0 ? page : 1,
    }),
  );
});

/** Riwayat pembelian (PI) per barang (read-only): what each item was bought at. Purchase prices are cost data, hence view_costs. */
accurateRouter.get("/purchase-history", requirePermission("view_costs"), async (c) => {
  const page = Number(c.req.query("page"));
  return c.json(
    await purchaseHistory(c.env.DB, catalogEntity(c.env), {
      q: (c.req.query("q") ?? "").trim().slice(0, 100),
      page: Number.isInteger(page) && page > 0 ? page : 1,
    }),
  );
});

/**
 * Laporan jual di bawah beli (Ryoma, 2026-11-10): SI lines whose net price is under the PI price of
 * their date, for invoices dated from..to (default the last 30 days). Cost data, hence view_costs.
 */
accurateRouter.get("/below-cost", requirePermission("view_costs"), async (c) => {
  const day = /^\d{4}-\d{2}-\d{2}$/;
  const today = new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10); // WIB
  const to = c.req.query("to") ?? today;
  const valid = (d: string) => day.test(d) && !Number.isNaN(Date.parse(d));
  const from = c.req.query("from") ?? (valid(to) ? new Date(Date.parse(to) - 30 * 86_400_000).toISOString().slice(0, 10) : "");
  if (!valid(from) || !valid(to) || from > to) {
    return c.json({ error: "Tanggal tidak valid. Tanggal awal tidak boleh setelah tanggal akhir." }, 400);
  }
  // shortcut: reads every SI line in the range per request; a year is ~tens of thousands of D1 rows, cache if opened often.
  if (Date.parse(to) - Date.parse(from) > 366 * 86_400_000) return c.json({ error: "Rentang maksimal 1 tahun" }, 400);
  const report = await salesBelowCostBetween(c.env.DB, catalogEntity(c.env), from, to, costLines(c.env));
  // Each row's explanation task (the latest per SI line of an item), for "Jelaskan" (Ryoma, 2026-11-28).
  const tasks = await all<BelowCostTask & { line_id: string; code: string }>(
    c.env.DB,
    `SELECT t.id, t.line_id, t.code, t.status, t.detail, t.resolution, t.created_at, cu.name AS created_by_name, ru.name AS resolved_by_name
       FROM fix_tasks t LEFT JOIN users cu ON cu.id = t.created_by LEFT JOIN users ru ON ru.id = t.resolved_by
      WHERE t.kind = 'below_cost' AND t.line_id IN (SELECT value FROM json_each(?))
      ORDER BY t.id`,
    JSON.stringify([...new Set(report.below.map((r) => r.invoiceNo))]),
  );
  const byKey = new Map(tasks.map(({ line_id, code, ...t }) => [belowCostDedupe(line_id, code), t]));
  return c.json({ from, to, ...report, below: report.below.map((r) => ({ ...r, task: byKey.get(belowCostDedupe(r.invoiceNo, r.code)) ?? null })) });
});

/**
 * "Jelaskan" a Jual < Beli row (Ryoma, 2026-11-28): what really happened, in the team's words, becomes an open
 * "Jual di bawah beli" task in Perlu diperbaiki. The row is read again from the SI, so the task carries the facts
 * as they are now; a line no longer under cost can't be explained. One open task per SI line of an item.
 */
accurateRouter.post("/below-cost/explain", requirePermission("view_costs"), async (c) => {
  const user = c.get("user")!;
  const parsed = z
    .object({
      invoice_no: z.string().trim().min(1).max(60),
      code: z.string().trim().min(1).max(64),
      explanation: z.string().trim().min(5, "Tulis singkat apa yang sebenarnya terjadi.").max(1000),
    })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: zodMessage(parsed.error) }, 400);
  const { invoice_no, code, explanation } = parsed.data;
  const { below } = await salesBelowCostOfInvoice(c.env.DB, catalogEntity(c.env), invoice_no, costLines(c.env));
  const rows = below.filter((r) => r.code === code);
  if (!rows.length) return c.json({ error: `${code} di ${invoice_no} tidak (lagi) dijual di bawah harga beli.` }, 404);
  const r = rows[0];
  const loss = rows.reduce((s, x) => s + x.lossTotal, 0);
  const rp = (n: number) => `Rp ${Math.round(n).toLocaleString("id-ID")}`;
  const context = `${invoice_no} · ${r.customerName} · ${r.transDate} · jual ${rp(r.net)}/${r.trace.baseUom || "satuan"}, beli ${rp(r.cost)} (${r.receiptNo}) · rugi ${rp(loss)}`;
  const qty = rows.reduce((s, x) => s + (x.trace.quantity - x.trace.returnQty), 0);
  try {
    const res = await run(
      c.env.DB,
      `INSERT INTO fix_tasks(kind, quote_id, line_id, code, item_name, qty, uom, detail, context, dedupe, created_by)
       VALUES ('below_cost', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      invoice_no, code, r.name.slice(0, 300), qty, r.trace.unit.slice(0, 32), explanation, context, belowCostDedupe(invoice_no, code), user.id,
    );
    const id = Number(res.meta.last_row_id);
    await audit(c.env.DB, user.id, "fix_task", id, "created", { kind: "below_cost", invoice_no, code });
    return c.json({ id }, 201);
  } catch (e) {
    if (String(e).includes("UNIQUE")) return c.json({ error: "Baris ini sudah punya tugas yang masih terbuka di Perlu diperbaiki." }, 409);
    throw e;
  }
});

/**
 * Stock UOM Adjustment (Ryoma, 2026-11-17): a unit ratio set in the app for an item whose SI and PI units
 * differ, so the two compare per the same base unit (shared/uomAdjust.ts). Wins over Accurate's ratio in
 * every cost reader; Accurate is not changed. Reading is cost data (view_costs); writing moves COGS
 * (apply-cogs reads it), so it takes edit_catalog too.
 */
accurateRouter.get("/uom-adjustments", requirePermission("view_costs"), async (c) => {
  const rows = await all<{ code: string; uom: string; factor: number; note: string; updated_at: string; updated_by: string | null }>(
    c.env.DB,
    `SELECT a.code, a.uom, a.factor, a.note, a.updated_at, u.name AS updated_by
       FROM uom_adjustments a LEFT JOIN users u ON u.id = a.updated_by
      WHERE a.entity = ?1 ORDER BY a.code, a.uom`,
    catalogEntity(c.env),
  );
  return c.json({ adjustments: rows.map((r) => ({ code: r.code, uom: r.uom, factor: r.factor, note: r.note, updatedAt: r.updated_at, updatedBy: r.updated_by })) });
});

const uomAdjustBody = z.object({
  code: z.string().trim().min(1).max(64),
  uom: z.string().trim().min(1).max(32),
  factor: z.number().finite().positive().max(1_000_000),
  note: z.string().trim().max(300).default(""),
});

accurateRouter.put("/uom-adjustments", requirePermission("view_costs"), requirePermission("edit_catalog"), async (c) => {
  const parsed = uomAdjustBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: zodMessage(parsed.error) }, 400);
  const { code, uom, factor, note } = parsed.data;
  const entity = catalogEntity(c.env);
  const item = await get<{ uom: string }>(c.env.DB, "SELECT COALESCE(NULLIF(uom, ''), 'Pcs') AS uom FROM accurate_items WHERE entity = ?1 AND code = ?2", entity, code);
  if (!item) return c.json({ error: `Barang ${code} tidak ada di data Accurate.` }, 404);
  if (item.uom.trim().toLowerCase() === uom.toLowerCase()) {
    return c.json({ error: `${uom} adalah satuan dasar ${code}; rasionya selalu 1.` }, 400);
  }
  const user = c.get("user")!;
  await batch(c.env.DB, [
    stmt(
      c.env.DB,
      `INSERT INTO uom_adjustments(entity, code, uom, factor, note, updated_by) VALUES(?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT(entity, code, uom) DO UPDATE SET factor = excluded.factor, note = excluded.note,
              updated_by = excluded.updated_by, updated_at = datetime('now')`,
      entity, code, uom, factor, note, user.id,
    ),
  ]);
  await audit(c.env.DB, user.id, "catalog", 0, "uom_adjusted", { entity, code, uom, factor, baseUom: item.uom, note });
  return c.json({ code, uom, factor, baseUom: item.uom });
});

accurateRouter.delete("/uom-adjustments", requirePermission("view_costs"), requirePermission("edit_catalog"), async (c) => {
  const parsed = uomAdjustBody.pick({ code: true, uom: true }).safeParse({ code: c.req.query("code") ?? "", uom: c.req.query("uom") ?? "" });
  if (!parsed.success) return c.json({ error: zodMessage(parsed.error) }, 400);
  const { code, uom } = parsed.data;
  const entity = catalogEntity(c.env);
  const old = await get<{ factor: number }>(c.env.DB, "SELECT factor FROM uom_adjustments WHERE entity = ?1 AND code = ?2 AND uom = ?3", entity, code, uom);
  if (!old) return c.json({ error: "Penyesuaian tidak ditemukan." }, 404);
  await batch(c.env.DB, [stmt(c.env.DB, "DELETE FROM uom_adjustments WHERE entity = ?1 AND code = ?2 AND uom = ?3", entity, code, uom)]);
  await audit(c.env.DB, c.get("user")!.id, "catalog", 0, "uom_adjustment_removed", { entity, code, uom, factor: old.factor });
  return c.json({ ok: true });
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
  const st = await loadReceiptState(c.env.DB, entity, costKind(c.env));
  if (!st.last_pass_at) {
    return c.json({ error: `Data PI Accurate ${entity} belum lengkap. Tunggu sinkron PI berikutnya selesai.` }, 409);
  }
  const result = await applyPurchaseCosts(c.env.DB, entity, { dryRun: parsed.data.dryRun, lines: costLines(c.env) });
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
  // The preview also shows each item's last selling price (any client, 12 months, below-COGS kept), to weigh the new COGS against.
  const codes = result.dryRun && salesEnabled(c.env) ? [...result.changed, ...result.held].map((x) => x.code) : [];
  const items = codes.length
    ? await all<{ code: string; uom: string }>(c.env.DB, "SELECT code, uom FROM catalog_items WHERE code IN (SELECT value FROM json_each(?1))", JSON.stringify(codes))
    : [];
  const sold = Object.fromEntries(await lastSales(c.env.DB, entity, items.map((i) => ({ ...i, cogs: 0 })), ""));
  return c.json({
    ...result,
    lastSales: sold,
    receipts: { lastPassAt: st.last_pass_at, through: st.since_update, inProgress: !!st.pass_started_at },
  });
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
    const st = await loadReceiptState(c.env.DB, entity, costKind(c.env));
    if (!st.last_pass_at) {
      return c.json({ error: `Data PI Accurate ${entity} belum lengkap. Tunggu sinkron PI berikutnya selesai.` }, 409);
    }
    return c.json(await applyHeldCosts(c.env.DB, entity, c.get("user")!.id, parsed.data.items, costLines(c.env)));
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
    // Purchase invoices (2026-11-09, modal from PI): ?pinvoice=<nomor PI> returns its raw detail and the
    // lines as the PI sync would store them, so "Total termasuk pajak" and the ÷1,11 can be checked by hand.
    let purchase: unknown = null;
    const pinvoice = c.req.query("pinvoice");
    if (pinvoice) {
      try {
        const detail = await client.raw("purchase-invoice/detail.do", { number: pinvoice });
        const d = (detail as { d?: Record<string, unknown> }).d;
        purchase = { detail, stored: d ? mapPurchaseLines(d) : null };
      } catch (err) {
        purchase = { error: (err as Error).message };
      }
    }
    // Izin baca semua transaksi yang menggerakkan stok (2026-11-25): ?mutations=1 mencoba tiap endpoint sekali
    // (1 baris, terbaru) dan melaporkan per endpoint: jumlah data, contoh baris, atau galatnya. Hanya membaca;
    // "insufficient_scope" berarti izin baca jenis itu belum diberikan pada token. Izin tulis tidak dicek.
    let mutations: unknown = null;
    if (c.req.query("mutations") === "1") {
      const check = async (path: string, params: Record<string, string | number>) => {
        try {
          const body = (await client.raw(path, params)) as { d?: unknown; sp?: { rowCount?: number } };
          return { ok: true, rowCount: body.sp?.rowCount ?? null, sample: Array.isArray(body.d) ? body.d.slice(0, 1) : body.d ?? null };
        } catch (err) {
          return { ok: false, error: (err as Error).message };
        }
      };
      const latest = { "sp.page": 1, "sp.pageSize": 1, "sp.sort": "id|desc" };
      const itemNo = ((items as { d?: { no?: string }[] }).d ?? [])[0]?.no;
      mutations = {
        stockMutationHistory: await check("item/stock-mutation-history.do", { "sp.page": 1, "sp.pageSize": 3 }),
        itemAdjustment: await check("item-adjustment/list.do", { ...latest, fields: "id,number,transDate" }),
        deliveryOrder: await check("delivery-order/list.do", { ...latest, fields: "id,number,transDate" }),
        itemTransfer: await check("item-transfer/list.do", { ...latest, fields: "id,number,transDate" }),
        salesReturn: await check("sales-return/list.do", { ...latest, fields: "id,number,transDate" }),
        purchaseReturn: await check("purchase-return/list.do", { ...latest, fields: "id,number,transDate" }),
        receiveItem: await check("receive-item/list.do", { ...latest, fields: "id,number,transDate" }),
        salesInvoice: await check("sales-invoice/list.do", { ...latest, fields: "id,number,transDate" }),
        purchaseInvoice: await check("purchase-invoice/list.do", { ...latest, fields: "id,number,transDate" }),
        getStock: itemNo ? await check("item/get-stock.do", { no: itemNo }) : { ok: false, error: "tidak ada barang untuk dicoba" },
      };
    }
    return c.json({ host: info.host, alias: info.alias, items, warehouses, stock, receipts, receiptFilterCheck, receiptDetail, sales, purchase, mutations });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 502);
  }
});
