/* Cross-check of the catalog against one Accurate entity's staged data
   (shared/accurateReconcile.ts). Read-only towards Accurate and towards the
   catalog: it only reads the staging tables and writes "Perlu diperbaiki"
   tasks. Items are matched by exact code, the same match "Terapkan" uses, so
   the report predicts what applying would touch.

   Each check's WHERE is the single definition used for both the count and
   the example rows, so the number and the list can't disagree. D1 charges a
   query per statement of a batch (Free: 50 per invocation); a full check is
   at most 12. */

import { all, batch, get, run, stmt } from "../../db.d1";
import {
  CHECKS,
  CHECK_KEYS,
  EXAMPLES_IN_TASK,
  desiredTasks,
  fmtMoney,
  type CheckKey,
  type ExampleRow,
  type ReconcileCounts,
} from "../../../shared/accurateReconcile";
import type { EntityKey } from "./sync";

/** Accurate's base unit equals the catalog's (Accurate's blank unit is "Pcs", as in apply). */
const SAME_UOM = "lower(trim(COALESCE(NULLIF(a.uom, ''), 'Pcs'))) = lower(trim(c.uom))";

interface RowCheck {
  where: string;
  catalog: string;
  accurate: string;
  /** How the two values are shown in the report. */
  fmt: "money" | "text" | "none";
}

/** catalog_items c LEFT JOIN accurate_items a (entity = ?1). Prices are per base unit, so they are only compared when the units agree. */
const ROW_CHECKS: Record<Exclude<CheckKey, "negative_stock">, RowCheck> = {
  price_below_cogs: {
    where: `a.code IS NOT NULL AND ${SAME_UOM} AND c.cogs > 0 AND a.unit_price > 0 AND a.unit_price < c.cogs`,
    catalog: "c.cogs",
    accurate: "a.unit_price",
    fmt: "money",
  },
  price_diff: {
    where: `a.code IS NOT NULL AND ${SAME_UOM} AND c.list_price > 0 AND a.unit_price > 0 AND abs(c.list_price - a.unit_price) > 0.5`,
    catalog: "c.list_price",
    accurate: "a.unit_price",
    fmt: "money",
  },
  uom_diff: {
    where: `a.code IS NOT NULL AND NOT (${SAME_UOM})`,
    catalog: "c.uom",
    accurate: "COALESCE(NULLIF(a.uom, ''), 'Pcs')",
    fmt: "text",
  },
  suspended_in_accurate: { where: "a.code IS NOT NULL AND a.suspended = 1", catalog: "''", accurate: "''", fmt: "none" },
  missing_in_accurate: { where: "a.code IS NULL", catalog: "''", accurate: "''", fmt: "none" },
  no_price_in_accurate: { where: "a.code IS NOT NULL AND a.suspended = 0 AND a.unit_price <= 0", catalog: "''", accurate: "''", fmt: "none" },
};

const FROM = `FROM catalog_items c LEFT JOIN accurate_items a ON a.entity = ?1 AND a.code = c.code`;

const ROW_KEYS = Object.keys(ROW_CHECKS) as (keyof typeof ROW_CHECKS)[];

/** True once the entity has a completed run that hasn't been cross-checked yet. */
export async function reconcileDue(db: D1Database, entity: EntityKey): Promise<boolean> {
  const st = await get<{ phase: string; last_success_at: string | null; reconciled_at: string | null }>(
    db,
    "SELECT phase, last_success_at, reconciled_at FROM accurate_sync_state WHERE entity = ?",
    entity,
  );
  if (!st || st.phase !== "idle" || !st.last_success_at) return false;
  return !st.reconciled_at || st.reconciled_at < st.last_success_at;
}

/** Counts for every check, in one statement over the catalog plus one over stock. */
export async function reconcileCounts(db: D1Database, entity: EntityKey): Promise<ReconcileCounts> {
  const sums = ROW_KEYS.map((k) => `COALESCE(SUM(CASE WHEN ${ROW_CHECKS[k].where} THEN 1 ELSE 0 END), 0) AS ${k}`).join(", ");
  const [rows, neg] = await batch(db, [
    stmt(db, `SELECT ${sums} ${FROM}`, entity),
    stmt(db, "SELECT COUNT(DISTINCT item_code) AS n FROM accurate_stock WHERE entity = ? AND quantity < 0", entity),
  ]);
  const r = (rows.results[0] ?? {}) as Record<string, number>;
  const out = {} as ReconcileCounts;
  for (const k of CHECK_KEYS) out[k] = k === "negative_stock" ? Number((neg.results[0] as { n: number } | undefined)?.n ?? 0) : Number(r[k] ?? 0);
  return out;
}

const show = (fmt: RowCheck["fmt"], v: unknown) => (fmt === "money" ? fmtMoney(v) : fmt === "text" ? String(v ?? "") : "");

/** Example rows for one check, largest gap first where there is a gap. */
export async function reconcileExamples(db: D1Database, entity: EntityKey, key: CheckKey, limit: number): Promise<ExampleRow[]> {
  if (key === "negative_stock") {
    const rows = await all<{ code: string; name: string | null; qty: number }>(
      db,
      `SELECT s.item_code AS code, COALESCE(c.name, a.name, '') AS name, SUM(s.quantity) AS qty
         FROM accurate_stock s
         LEFT JOIN accurate_items a ON a.entity = s.entity AND a.code = s.item_code
         LEFT JOIN catalog_items c ON c.code = s.item_code
        WHERE s.entity = ?1 AND s.quantity < 0
        GROUP BY s.item_code ORDER BY MIN(s.quantity) LIMIT ?2`,
      entity,
      limit,
    );
    return rows.map((r) => ({ code: r.code, name: r.name ?? "", catalog: "", accurate: `stok ${r.qty}` }));
  }
  const def = ROW_CHECKS[key];
  const rows = await all<{ code: string; name: string; cat: unknown; acc: unknown }>(
    db,
    `SELECT c.code, c.name, ${def.catalog} AS cat, ${def.accurate} AS acc ${FROM}
      WHERE ${def.where}
      ORDER BY abs(COALESCE(c.list_price, 0) - COALESCE(a.unit_price, 0)) DESC, c.code LIMIT ?2`,
    entity,
    limit,
  );
  return rows.map((r) => ({ code: r.code, name: r.name, catalog: show(def.fmt, r.cat), accurate: show(def.fmt, r.acc) }));
}

/**
 * Counts the checks, then makes the open "Perlu diperbaiki" tasks match: one
 * per notifying check with a mismatch (created, or its text and count
 * refreshed), and any whose mismatch is gone closed. At most 1 + 1 + 5 + 2 + 1
 * statements; the caller needs nothing else from the 50-query budget.
 */
export async function runReconcile(db: D1Database, entity: EntityKey): Promise<{ counts: ReconcileCounts; open: number; closed: number }> {
  const counts = await reconcileCounts(db, entity);
  const examples: Partial<Record<CheckKey, ExampleRow[]>> = {};
  for (const k of CHECK_KEYS) {
    if (CHECKS[k].notify && counts[k] > 0) examples[k] = await reconcileExamples(db, entity, k, EXAMPLES_IN_TASK);
  }
  const wanted = desiredTasks(counts, examples);
  const rows = wanted.map((t) => ({
    kind: "accurate_check",
    code: t.key,
    item_name: t.label,
    qty: t.count,
    uom: "barang",
    detail: t.detail,
    dedupe: `accurate_check|${t.key}`,
  }));
  const [, closed] = await batch(db, [
    stmt(
      db,
      `INSERT INTO fix_tasks(kind, quote_id, line_id, code, item_name, qty, uom, detail, dedupe, created_by)
       SELECT json_extract(j.value, '$.kind'), NULL, NULL, json_extract(j.value, '$.code'), json_extract(j.value, '$.item_name'),
              json_extract(j.value, '$.qty'), json_extract(j.value, '$.uom'), json_extract(j.value, '$.detail'),
              json_extract(j.value, '$.dedupe'), NULL
         FROM json_each(?) j WHERE true
       ON CONFLICT(dedupe) WHERE status = 'open' DO UPDATE SET
         qty = excluded.qty, detail = excluded.detail, item_name = excluded.item_name`,
      JSON.stringify(rows),
    ),
    stmt(
      db,
      `UPDATE fix_tasks SET status = 'done', resolved_at = datetime('now'),
              resolution = 'Selisih sudah tidak ada (dicek otomatis).'
        WHERE kind = 'accurate_check' AND status = 'open' AND code NOT IN (SELECT value FROM json_each(?))`,
      JSON.stringify(wanted.map((t) => t.key)),
    ),
  ]);
  await run(db, "UPDATE accurate_sync_state SET reconciled_at = ? WHERE entity = ?", new Date().toISOString(), entity);
  return { counts, open: wanted.length, closed: closed.meta.changes };
}
