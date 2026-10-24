/* ============================================================
   Accurate goods receipts (Penerimaan Barang) → accurate_receipt_lines,
   the history behind COGS = harga pembelian terakhir
   (shared/lastPurchaseCost.ts).

   Accurate can't be asked for "the last receipt of item X": receive-item
   list.do has no item filter, and item/stock-mutation-history.do only keeps
   7 days. So every receipt is read once, one detail call each, and read
   again only when Accurate's lastUpdate says it changed.

   A pass lists receipts with lastUpdate >= the previous pass's highest
   lastUpdate (the first pass: transDate >= ACCURATE_RECEIPTS_SINCE), sorted
   by id, and fetches each detail. Progress is kept per receipt (page +
   row_idx), not per page, so a call budget smaller than a page still moves
   forward. Re-reading a receipt is harmless: its lines are replaced whole,
   so a line removed in Accurate disappears here too.

   Off unless ACCURATE_RECEIPTS_ENABLED = "true", and only for the catalog's
   entity (sync.ts syncTick).
   ============================================================ */

import { batch, get, run, stmt } from "../../db.d1";
import { AccurateClient, AccurateError, type AccurateCreds } from "./client";
import { RECEIPT_LIST_FIELDS, mapReceipt, mapReceiptLines, updateKey, type StagedReceiptLine } from "./mapping";
import type { Bindings } from "../env";
import { catalogEntity, credsFor, syncConfig, type EntityKey } from "./sync";

export interface ReceiptState {
  entity: EntityKey;
  since_update: string | null;
  max_update: string | null;
  backfill_since: string | null;
  page: number;
  row_idx: number;
  receipts_seen: number;
  pass_started_at: string | null;
  last_pass_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
  locked_until: string | null;
}

export interface ReceiptConfig {
  /** Receipts listed per page. Each costs one detail call, so this is kept below the call budget. */
  pageSize: number;
  everyHours: number;
  /** First pass only: receipts dated on or after this day (dd/MM/yyyy). */
  since: string;
}

export const receiptsEnabled = (env: Pick<Bindings, "ACCURATE_RECEIPTS_ENABLED">) => env.ACCURATE_RECEIPTS_ENABLED === "true";

/** dd/MM/yyyy of a Date, in WIB (Accurate's clock for transaction dates). */
const wibDate = (d: Date) => {
  const w = new Date(d.getTime() + 7 * 3_600_000);
  return `${String(w.getUTCDate()).padStart(2, "0")}/${String(w.getUTCMonth() + 1).padStart(2, "0")}/${w.getUTCFullYear()}`;
};

/** dd/MM/yyyy HH:mm:ss of a Date in WIB, the format of Accurate's lastUpdate filter. */
export const wibTimestamp = (d: Date) => {
  const w = new Date(d.getTime() + 7 * 3_600_000);
  const t = [w.getUTCHours(), w.getUTCMinutes(), w.getUTCSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
  return `${wibDate(d)} ${t}`;
};

export function receiptConfig(env: Bindings, now = new Date()): ReceiptConfig {
  const n = (v: string | undefined, d: number, min: number, max: number) => {
    const x = Number(v);
    return Number.isFinite(x) && x > 0 ? Math.min(max, Math.max(min, Math.floor(x))) : d;
  };
  // ACCURATE_RECEIPTS_SINCE = YYYY-MM-DD; default one year back.
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(env.ACCURATE_RECEIPTS_SINCE ?? "");
  const since = m ? `${m[3]}/${m[2]}/${m[1]}` : wibDate(new Date(now.getTime() - 365 * 86_400_000));
  return {
    pageSize: n(env.ACCURATE_RECEIPTS_PAGE_SIZE, 20, 1, 100),
    everyHours: n(env.ACCURATE_SYNC_EVERY_HOURS, 6, 1, 24 * 7),
    since,
  };
}

const hoursSince = (iso: string | null) => (iso ? (Date.now() - Date.parse(iso)) / 3_600_000 : Infinity);

export async function loadReceiptState(db: D1Database, entity: EntityKey): Promise<ReceiptState> {
  await run(db, "INSERT OR IGNORE INTO accurate_receipt_state(entity) VALUES(?)", entity);
  return (await get<ReceiptState>(db, "SELECT * FROM accurate_receipt_state WHERE entity = ?", entity))!;
}

export interface ReceiptStepResult {
  outcome: "locked" | "idle" | "progress" | "finished" | "error";
  calls: number;
  lines: number;
  error?: string;
}

export async function receiptStep(
  db: D1Database,
  entity: EntityKey,
  creds: AccurateCreds,
  cfg: ReceiptConfig,
  opts: { budget: number; deadline: number; fetchImpl?: typeof fetch; gapMs?: number },
): Promise<ReceiptStepResult> {
  await run(db, "INSERT OR IGNORE INTO accurate_receipt_state(entity) VALUES(?)", entity);
  const lock = await run(
    db,
    `UPDATE accurate_receipt_state SET locked_until = datetime('now', '+5 minutes')
      WHERE entity = ? AND (locked_until IS NULL OR locked_until < datetime('now'))`,
    entity,
  );
  if (!lock.meta.changes) return { outcome: "locked", calls: 0, lines: 0 };

  let st = (await get<ReceiptState>(db, "SELECT * FROM accurate_receipt_state WHERE entity = ?", entity))!;
  const setSql = (fields: Partial<ReceiptState>) => {
    st = { ...st, ...fields };
    const keys = Object.keys(fields);
    return stmt(
      db,
      `UPDATE accurate_receipt_state SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE entity = ?`,
      ...keys.map((k) => (fields as Record<string, string | number | null>)[k]),
      entity,
    );
  };
  let lines = 0;
  let client: AccurateClient | null = null;

  try {
    if (!st.pass_started_at) {
      if (hoursSince(st.last_pass_at) < cfg.everyHours) return { outcome: "idle", calls: 0, lines: 0 };
      await batch(db, [
        setSql({
          pass_started_at: new Date().toISOString(),
          page: 1,
          row_idx: 0,
          receipts_seen: 0,
          max_update: st.since_update,
          // Fixed for the whole pass: the default start ("a year back") moves with the clock,
          // and a backfill spanning days would otherwise drop receipts and shift the pages.
          backfill_since: st.since_update ? null : cfg.since,
        }),
      ]);
    }

    // The item sync keeps the database host fresh; reuse it.
    const host = await get<{ host: string | null }>(db, "SELECT host FROM accurate_sync_state WHERE entity = ?", entity);
    client = new AccurateClient(creds, host?.host ?? null, opts.fetchImpl, opts.gapMs);
    const c = client;
    if (!host?.host) {
      // Kept for the next tick too: re-resolving every tick would spend a small budget on it alone.
      const info = await c.tokenInfo();
      await run(db, "INSERT OR IGNORE INTO accurate_sync_state(entity) VALUES(?)", entity);
      await run(
        db,
        "UPDATE accurate_sync_state SET host = ?, db_alias = ?, host_checked_at = ? WHERE entity = ?",
        info.host, info.alias, new Date().toISOString(), entity,
      );
    }
    const budgetLeft = (need: number) => c.calls + need <= opts.budget && Date.now() < opts.deadline;

    const filter: Record<string, string> = st.since_update
      ? { "filter.lastUpdate.op": "GREATER_EQUAL_THAN", "filter.lastUpdate.val": st.since_update }
      : { "filter.transDate.op": "GREATER_EQUAL_THAN", "filter.transDate.val": st.backfill_since ?? cfg.since };

    let finished = false;
    // A page listing plus at least one detail must fit, or the tick only re-lists.
    while (!finished && budgetLeft(2)) {
      const res = await c.list("receive-item/list.do", {
        fields: RECEIPT_LIST_FIELDS,
        ...filter,
        "sp.page": st.page,
        "sp.pageSize": cfg.pageSize,
        "sp.sort": "id|asc",
      });
      const receipts = res.rows.map(mapReceipt).filter((x) => x !== null);

      const done: number[] = [];
      const fetched: StagedReceiptLine[] = [];
      let idx = st.row_idx;
      let maxUpdate = st.max_update;
      for (; idx < receipts.length; idx++) {
        const r = receipts[idx];
        if (r.received) {
          if (!budgetLeft(1)) break;
          const d = await c.detail("receive-item/detail.do", { id: r.accurateId });
          if (d) fetched.push(...mapReceiptLines(d));
        }
        done.push(r.accurateId);
        if (updateKey(r.lastUpdate) > updateKey(maxUpdate)) maxUpdate = r.lastUpdate;
      }

      const pageDone = idx >= receipts.length;
      const lastPage = res.rows.length === 0 || st.page >= res.pageCount;
      // A pass spans ticks and lists by id, not by lastUpdate. A receipt edited after an
      // earlier tick read it would stay below maxUpdate (the highest lastUpdate seen), so a
      // cursor set to maxUpdate alone would never ask for that edit again. Keep a 10-minute
      // overlap before the pass started; min() still advances past edits older than that.
      let since = maxUpdate;
      if (st.pass_started_at && Number.isFinite(Date.parse(st.pass_started_at))) {
        const floor = wibTimestamp(new Date(Date.parse(st.pass_started_at) - 10 * 60_000));
        if (!since) since = st.since_update ? floor : null;
        else if (updateKey(floor) < updateKey(since)) since = floor;
      }
      const next: Partial<ReceiptState> = !pageDone
        ? { row_idx: idx }
        : lastPage
          ? { since_update: since, max_update: maxUpdate, page: 1, row_idx: 0, pass_started_at: null, last_pass_at: new Date().toISOString() }
          : { page: st.page + 1, row_idx: 0 };
      // One statement each (json_each): D1 bills every statement of a batch.
      await batch(db, [
        stmt(
          db,
          `DELETE FROM accurate_receipt_lines
            WHERE entity = ?1 AND receipt_id IN (SELECT value FROM json_each(?2))`,
          entity,
          JSON.stringify(done),
        ),
        stmt(
          db,
          `INSERT OR REPLACE INTO accurate_receipt_lines(entity, receipt_id, line_id, receipt_no, trans_date,
                                                         item_code, unit, quantity, unit_price, synced_at)
           SELECT ?1, json_extract(j.value, '$.receiptId'), json_extract(j.value, '$.lineId'),
                  json_extract(j.value, '$.receiptNo'), json_extract(j.value, '$.transDate'),
                  json_extract(j.value, '$.itemCode'), json_extract(j.value, '$.unit'),
                  json_extract(j.value, '$.quantity'), json_extract(j.value, '$.unitPrice'), datetime('now')
             FROM json_each(?2) j WHERE true`,
          entity,
          JSON.stringify(fetched),
        ),
        setSql({ ...next, max_update: next.max_update ?? maxUpdate, receipts_seen: st.receipts_seen + done.length }),
      ]);
      lines += fetched.length;
      finished = pageDone && lastPage;
      if (!pageDone) break; // out of budget mid-page
    }

    if (st.last_error) await batch(db, [setSql({ last_error: null, last_error_at: null })]);
    return { outcome: finished ? "finished" : "progress", calls: c.calls, lines };
  } catch (err) {
    const msg = err instanceof AccurateError ? `${err.message} (HTTP ${err.status})` : String((err as Error)?.message ?? err);
    await batch(db, [setSql({ last_error: msg.slice(0, 500), last_error_at: new Date().toISOString() })]);
    return { outcome: "error", calls: client?.calls ?? 0, lines, error: msg };
  } finally {
    await run(db, "UPDATE accurate_receipt_state SET locked_until = NULL WHERE entity = ?", entity);
  }
}

/**
 * Own cron entry (wrangler.toml), two minutes after the item sync's ticks: each
 * entry is a separate invocation with its own 50-subrequest budget, and the
 * item run (~300 calls at 5 per tick) is busy most of the day, so receipts
 * waiting for it to be idle would rarely move.
 */
export const RECEIPTS_CRON = "2,7,12,17,22,27,32,37,42,47,52,57 * * * *";

export async function receiptsTick(env: Bindings, opts: { deadlineMs: number; fetchImpl?: typeof fetch; gapMs?: number }) {
  if (!receiptsEnabled(env) || env.ACCURATE_SYNC_ENABLED === "false") return null;
  const entity = catalogEntity(env);
  const creds = credsFor(env, entity);
  if (!creds) return null;
  return receiptStep(env.DB, entity, creds, receiptConfig(env), {
    budget: syncConfig(env).callsPerTick,
    deadline: Date.now() + opts.deadlineMs,
    fetchImpl: opts.fetchImpl,
    gapMs: opts.gapMs,
  });
}
