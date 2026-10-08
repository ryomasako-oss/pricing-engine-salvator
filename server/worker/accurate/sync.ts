/* ============================================================
   Resumable Accurate → D1 staging sync.

   A full pull (≈30k items + stock per warehouse) is far more calls than
   one Worker invocation should make, so the work is a cursor stored in
   accurate_sync_state and advanced a bounded number of API calls per
   tick (cron, or the manual "Sinkron sekarang" button). Each page is
   committed before the cursor moves, so a crash or timeout only ever
   repeats one page.

   Phases per entity:  idle → items → warehouses → stock → idle
   Rows not seen by the finishing run (deleted in Accurate) are pruned.
   ============================================================ */

import { reconcileDue, runReconcile } from "./reconcile";
import { all, batch, get, run, stmt } from "../../db.d1";
import { AccurateClient, AccurateError, type AccurateCreds } from "./client";
import { ITEM_FIELDS, mapItem, mapStock, mapWarehouse } from "./mapping";
import type { Bindings } from "../env";

export type EntityKey = "CV" | "PT";
export const ENTITY_KEYS: EntityKey[] = ["CV", "PT"];

export interface SyncState {
  entity: EntityKey;
  host: string | null;
  host_checked_at: string | null;
  db_alias: string | null;
  run_id: string | null;
  phase: "idle" | "items" | "warehouses" | "stock";
  page: number;
  warehouse_idx: number;
  items_seen: number;
  stock_rows: number;
  started_at: string | null;
  last_success_at: string | null;
  reconciled_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
  locked_until: string | null;
  force_restart: number;
}

export interface SyncConfig {
  pageSize: number;
  callsPerTick: number;
  everyHours: number;
}

export function syncConfig(env: Bindings): SyncConfig {
  const n = (v: string | undefined, d: number, min: number, max: number) => {
    const x = Number(v);
    return Number.isFinite(x) && x > 0 ? Math.min(max, Math.max(min, Math.floor(x))) : d;
  };
  return {
    pageSize: n(env.ACCURATE_PAGE_SIZE, 100, 10, 1000),
    // Free-plan Workers allow 50 subrequests per invocation; keep headroom.
    callsPerTick: n(env.ACCURATE_CALLS_PER_TICK, 40, 1, 900),
    everyHours: n(env.ACCURATE_SYNC_EVERY_HOURS, 6, 1, 24 * 7),
  };
}

/** Credentials per entity; an entity without a token is simply not synced. */
export function credsFor(env: Bindings, entity: EntityKey): AccurateCreds | null {
  const token = entity === "CV" ? env.ACCURATE_TOKEN_CV : env.ACCURATE_TOKEN_PT;
  if (!token || !env.ACCURATE_SIGNATURE_SECRET) return null;
  return { token, signatureSecret: env.ACCURATE_SIGNATURE_SECRET };
}

/**
 * The one Data Usaha applied to the catalog (Ryoma, 2026-10-06: PT). Applying
 * both would make the second overwrite the first's prices and stock; the
 * other entity is synced, if it has a token, for the cross-entity checks only.
 */
export function catalogEntity(env: Pick<Bindings, "ACCURATE_CATALOG_ENTITY">): EntityKey {
  return env.ACCURATE_CATALOG_ENTITY === "CV" ? "CV" : "PT";
}

export function configuredEntities(env: Bindings): EntityKey[] {
  return ENTITY_KEYS.filter((e) => credsFor(env, e));
}

export async function loadState(db: D1Database, entity: EntityKey): Promise<SyncState> {
  await run(db, "INSERT OR IGNORE INTO accurate_sync_state(entity) VALUES(?)", entity);
  return (await get<SyncState>(db, "SELECT * FROM accurate_sync_state WHERE entity = ?", entity))!;
}

export async function requestRestart(db: D1Database, entity: EntityKey): Promise<void> {
  await run(db, "INSERT OR IGNORE INTO accurate_sync_state(entity) VALUES(?)", entity);
  await run(db, "UPDATE accurate_sync_state SET force_restart = 1 WHERE entity = ?", entity);
}

const HOST_TTL_DAYS = 30; // Accurate asks integrators to re-check the host monthly.
const hoursSince = (iso: string | null) =>
  iso ? (Date.now() - Date.parse(iso.replace(" ", "T") + (iso.endsWith("Z") ? "" : "Z"))) / 3_600_000 : Infinity;

export interface StepResult {
  entity: EntityKey;
  outcome: "locked" | "idle" | "progress" | "finished" | "error";
  phase: SyncState["phase"];
  calls: number;
  error?: string;
}

export async function syncStep(
  db: D1Database,
  entity: EntityKey,
  creds: AccurateCreds,
  cfg: SyncConfig,
  opts: { deadline: number; fetchImpl?: typeof fetch; gapMs?: number },
): Promise<StepResult> {
  await loadState(db, entity);
  const lock = await run(
    db,
    `UPDATE accurate_sync_state SET locked_until = datetime('now', '+5 minutes')
      WHERE entity = ? AND (locked_until IS NULL OR locked_until < datetime('now'))`,
    entity,
  );
  if (!lock.meta.changes) return { entity, outcome: "locked", phase: "idle", calls: 0 };

  let st = (await get<SyncState>(db, "SELECT * FROM accurate_sync_state WHERE entity = ?", entity))!;
  const save = (fields: Partial<SyncState>) => {
    st = { ...st, ...fields };
    const keys = Object.keys(fields);
    return run(
      db,
      `UPDATE accurate_sync_state SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE entity = ?`,
      ...keys.map((k) => (fields as Record<string, string | number | null>)[k]),
      entity,
    );
  };

  try {
    // Start (or restart) a run when due.
    const due = st.force_restart === 1 || (st.phase === "idle" && hoursSince(st.last_success_at) >= cfg.everyHours);
    if (st.phase === "idle" && !due) return { entity, outcome: "idle", phase: "idle", calls: 0 };
    if (due) {
      await save({
        run_id: new Date().toISOString(),
        phase: "items",
        page: 1,
        warehouse_idx: 0,
        items_seen: 0,
        stock_rows: 0,
        started_at: new Date().toISOString(),
        force_restart: 0,
      });
    }

    const hostFresh = st.host && hoursSince(st.host_checked_at) < HOST_TTL_DAYS * 24;
    const client = new AccurateClient(creds, hostFresh ? st.host : null, opts.fetchImpl, opts.gapMs);
    if (!hostFresh) {
      const info = await client.tokenInfo();
      await save({ host: info.host, db_alias: info.alias, host_checked_at: new Date().toISOString() });
    }
    const runId = st.run_id!;
    const budgetLeft = () => client.calls < cfg.callsPerTick && Date.now() < opts.deadline;

    let finished = false;
    while (!finished && budgetLeft()) {
      if (st.phase === "items") {
        const res = await client.list("item/list.do", {
          fields: ITEM_FIELDS,
          "sp.page": st.page,
          "sp.pageSize": cfg.pageSize,
          "sp.sort": "id|asc",
        });
        const items = res.rows.map(mapItem).filter((x) => x !== null);
        // One statement per page: D1 counts every statement of a batch as a query
        // (50 per invocation on the Free plan), so a row per statement would spend
        // the whole tick on one page.
        if (items.length) {
          await run(
            db,
            `INSERT INTO accurate_items(entity, accurate_id, code, name, item_type, uom, unit_price, units,
                                        category, suspended, run_id, synced_at)
             SELECT ?1, json_extract(j.value, '$.accurateId'), json_extract(j.value, '$.code'),
                    json_extract(j.value, '$.name'), json_extract(j.value, '$.itemType'),
                    json_extract(j.value, '$.uom'), json_extract(j.value, '$.unitPrice'),
                    json_extract(j.value, '$.units'), json_extract(j.value, '$.category'),
                    json_extract(j.value, '$.suspended'), ?3, datetime('now')
               FROM json_each(?2) j WHERE true
             ON CONFLICT(entity, accurate_id) DO UPDATE SET
               code = excluded.code, name = excluded.name, item_type = excluded.item_type,
               uom = excluded.uom, unit_price = excluded.unit_price, units = excluded.units,
               category = excluded.category, suspended = excluded.suspended,
               run_id = excluded.run_id, synced_at = excluded.synced_at`,
            entity,
            JSON.stringify(items.map((i) => ({ ...i, suspended: i.suspended ? 1 : 0 }))),
            runId,
          );
        }
        const done = res.rows.length === 0 || st.page >= res.pageCount;
        await save(
          done
            ? { phase: "warehouses", page: 1, items_seen: st.items_seen + items.length }
            : { page: st.page + 1, items_seen: st.items_seen + items.length },
        );
      } else if (st.phase === "warehouses") {
        const whs: { accurateId: number; name: string }[] = [];
        for (let p = 1; ; p++) {
          const res = await client.list("warehouse/list.do", { fields: "id,name", "sp.page": p, "sp.pageSize": 100 });
          whs.push(...res.rows.map(mapWarehouse).filter((x) => x !== null));
          if (res.rows.length === 0 || p >= res.pageCount) break;
        }
        await batch(db, [
          stmt(
            db,
            `INSERT INTO accurate_warehouses(entity, accurate_id, name, run_id)
             SELECT ?1, json_extract(j.value, '$.accurateId'), json_extract(j.value, '$.name'), ?3
               FROM json_each(?2) j WHERE true
             ON CONFLICT(entity, accurate_id) DO UPDATE SET name = excluded.name, run_id = excluded.run_id`,
            entity, JSON.stringify(whs), runId,
          ),
          stmt(db, "DELETE FROM accurate_warehouses WHERE entity = ? AND run_id <> ?", entity, runId),
        ]);
        await save({ phase: "stock", page: 1, warehouse_idx: 0 });
      } else if (st.phase === "stock") {
        const whs = await all<{ accurate_id: number }>(
          db,
          "SELECT accurate_id FROM accurate_warehouses WHERE entity = ? ORDER BY accurate_id",
          entity,
        );
        if (st.warehouse_idx >= whs.length) {
          finished = true;
          break;
        }
        const whId = whs[st.warehouse_idx].accurate_id;
        const res = await client.list("item/list-stock.do", {
          warehouseId: whId,
          "sp.page": st.page,
          "sp.pageSize": cfg.pageSize,
        });
        const rows = res.rows.map(mapStock).filter((x) => x !== null);
        if (rows.length) {
          await run(
            db,
            `INSERT INTO accurate_stock(entity, warehouse_id, item_code, quantity, run_id, synced_at)
             SELECT ?1, ?2, json_extract(j.value, '$.code'), json_extract(j.value, '$.quantity'), ?4, datetime('now')
               FROM json_each(?3) j WHERE true
             ON CONFLICT(entity, warehouse_id, item_code) DO UPDATE SET
               quantity = excluded.quantity, run_id = excluded.run_id, synced_at = excluded.synced_at`,
            entity, whId, JSON.stringify(rows), runId,
          );
        }
        const done = res.rows.length === 0 || st.page >= res.pageCount;
        await save(
          done
            ? { warehouse_idx: st.warehouse_idx + 1, page: 1, stock_rows: st.stock_rows + rows.length }
            : { page: st.page + 1, stock_rows: st.stock_rows + rows.length },
        );
      } else {
        break;
      }
    }

    if (client.movedTo) await save({ host: client.movedTo, host_checked_at: new Date().toISOString() });

    if (finished) {
      await batch(db, [
        stmt(db, "DELETE FROM accurate_items WHERE entity = ? AND run_id <> ?", entity, runId),
        stmt(db, "DELETE FROM accurate_stock WHERE entity = ? AND run_id <> ?", entity, runId),
      ]);
      await save({ phase: "idle", page: 1, warehouse_idx: 0, last_success_at: new Date().toISOString(), last_error: null });
      return { entity, outcome: "finished", phase: "idle", calls: client.calls };
    }
    return { entity, outcome: "progress", phase: st.phase, calls: client.calls };
  } catch (err) {
    const msg = err instanceof AccurateError ? `${err.message} (HTTP ${err.status})` : String((err as Error)?.message ?? err);
    // A bad token or host: forget the cached host so the next tick re-resolves it.
    const resetHost = err instanceof AccurateError && (err.status === 401 || err.status === 404);
    await save({
      last_error: msg.slice(0, 500),
      last_error_at: new Date().toISOString(),
      ...(resetHost ? { host_checked_at: null } : {}),
    });
    return { entity, outcome: "error", phase: st.phase, calls: 0, error: msg };
  } finally {
    await run(db, "UPDATE accurate_sync_state SET locked_until = NULL WHERE entity = ?", entity);
  }
}

/** One tick across all configured entities, sharing the call budget. */
export async function syncTick(env: Bindings, opts: { deadlineMs: number }): Promise<StepResult[]> {
  const cfg = syncConfig(env);
  const entities = configuredEntities(env);
  // Kill switch for the cron without removing secrets: ACCURATE_SYNC_ENABLED = "false".
  if (!entities.length || env.ACCURATE_SYNC_ENABLED === "false") return [];
  const per = { ...cfg, callsPerTick: Math.max(1, Math.floor(cfg.callsPerTick / entities.length)) };
  const deadline = Date.now() + opts.deadlineMs;
  const out: StepResult[] = [];
  for (const e of entities) out.push(await syncStep(env.DB, e, credsFor(env, e)!, per, { deadline }));
  // A completed run is cross-checked against the catalog in a later tick in
  // which the catalog's own entity is idle (the tick that finishes a run is
  // near the budget). The other entity may be syncing or failing meanwhile:
  // waiting for both to be idle at once starved the check for days (a CV
  // token failing on every tick meant PT was never checked). Its step plus
  // the check stays within 50 (accurate/reconcile.test.ts).
  const mine = catalogEntity(env);
  if (out.find((r) => r.entity === mine)?.outcome === "idle" && (await reconcileDue(env.DB, mine))) {
    await runReconcile(env.DB, mine);
  }
  return out;
}
