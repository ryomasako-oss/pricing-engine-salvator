/* Riwayat mutasi stok (2026-11-25). Accurate hanya menyimpan 7 hari terakhir di item/stock-mutation-history.do
   (izin stock_mutation_history_view, sudah ada di token PT: probe ?mutations=1). Tiap beberapa jam satu "pass"
   membaca seluruh jendela 7 hari itu (±1.100 baris, ±12 panggilan) dan menyimpannya di stock_mutations,
   supaya riwayatnya tetap ada sesudah hilang dari Accurate. Pass bisa berlanjut di tick berikutnya (page).

   Baris yang tidak lagi muncul (transaksinya dihapus atau diubah di Accurate) diberi removed_at, tidak dihapus,
   dan hanya bila pass membaca semuanya dan jumlahnya sama dengan rowCount Accurate; bila tidak, halaman yang
   bergeser bisa membuat baris yang masih ada tampak hilang. Baris dekat batas 7 hari tidak pernah ditandai. */

import { all, batch, get, run, stmt } from "../../db.d1";
import { AccurateClient, type AccurateCreds } from "./client";
import { catalogEntity, credsFor, syncConfig, type EntityKey } from "./sync";
import { matchEnteredCounts } from "./stock";
import type { Bindings } from "../env";

export const MUTATION_PAGE_SIZE = 100;

interface MutationState {
  entity: EntityKey;
  pass_id: string | null;
  page: number;
  rows_seen: number;
  last_pass_at: string | null;
  last_error: string | null;
}

export interface MutationStepResult {
  outcome: "locked" | "idle" | "progress" | "finished" | "error";
  calls: number;
  rows: number;
  removed?: number;
  entered?: number;
  error?: string;
}

/** "18/11/2026 07:52:05" -> "2026-11-18 07:52:05"; "17/11/2026" -> "2026-11-17". */
export function accurateDate(s: unknown): string | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})(?: (\d{2}:\d{2}:\d{2}))?$/.exec(String(s ?? "").trim());
  return m ? `${m[3]}-${m[2]}-${m[1]}${m[4] ? ` ${m[4]}` : ""}` : null;
}

export function mapMutation(r: Record<string, unknown>) {
  const id = Number(r.id);
  const qty = Number(r.mutation);
  const itemNo = String(r.itemNo ?? "").trim();
  if (!Number.isInteger(id) || !Number.isFinite(qty) || !itemNo) return null;
  return {
    id,
    item_no: itemNo,
    warehouse: String(r.warehouseName ?? "").trim(),
    trans_type: String(r.transactionType ?? "").trim(),
    trans_number: String(r.transactionNumber ?? "").trim(),
    trans_id: Number.isInteger(Number(r.transactionId)) ? Number(r.transactionId) : null,
    trans_date: accurateDate(r.transactionDate),
    created_wib: accurateDate(r.createDate),
    qty,
    item_cost: Number.isFinite(Number(r.itemCost)) ? Number(r.itemCost) : null,
  };
}

/** One statement per page (D1 counts each statement as a query): the rows go in as one JSON parameter. */
const UPSERT_SQL = `
  INSERT INTO stock_mutations(entity, accurate_id, item_no, warehouse, trans_type, trans_number, trans_id, trans_date, created_wib, qty, item_cost, seen_pass, removed_at)
  SELECT ?1, j.value ->> 'id', j.value ->> 'item_no', j.value ->> 'warehouse', j.value ->> 'trans_type', j.value ->> 'trans_number',
         j.value ->> 'trans_id', j.value ->> 'trans_date', j.value ->> 'created_wib', j.value ->> 'qty', j.value ->> 'item_cost', ?2, NULL
    FROM json_each(?3) j WHERE true -- SQLite: INSERT ... SELECT needs a WHERE before ON CONFLICT
  ON CONFLICT(entity, accurate_id) DO UPDATE SET
    item_no = excluded.item_no, warehouse = excluded.warehouse, trans_type = excluded.trans_type,
    trans_number = excluded.trans_number, trans_id = excluded.trans_id, trans_date = excluded.trans_date,
    created_wib = excluded.created_wib, qty = excluded.qty, item_cost = excluded.item_cost,
    seen_pass = excluded.seen_pass, removed_at = NULL`;

/** WIB "YYYY-MM-DD HH:MM:SS" of a Date (Accurate's createDate clock). */
const wib = (d: Date) => new Date(d.getTime() + 7 * 3_600_000).toISOString().slice(0, 19).replace("T", " ");

export async function mutationStep(
  db: D1Database,
  entity: EntityKey,
  creds: AccurateCreds,
  opts: { everyHours: number; budget: number; deadline: number; fetchImpl?: typeof fetch; gapMs?: number; now?: Date },
): Promise<MutationStepResult> {
  await run(db, "INSERT OR IGNORE INTO accurate_mutation_state(entity) VALUES(?)", entity);
  const lock = await run(
    db,
    `UPDATE accurate_mutation_state SET locked_until = datetime('now', '+5 minutes')
      WHERE entity = ? AND (locked_until IS NULL OR locked_until < datetime('now'))`,
    entity,
  );
  if (!lock.meta.changes) return { outcome: "locked", calls: 0, rows: 0 };
  let client: AccurateClient | null = null;
  try {
    let st = (await get<MutationState>(db, "SELECT * FROM accurate_mutation_state WHERE entity = ?", entity))!;
    const now = opts.now ?? new Date();
    const hours = st.last_pass_at ? (now.getTime() - Date.parse(st.last_pass_at)) / 3_600_000 : Infinity;
    if (!st.pass_id && hours < opts.everyHours) return { outcome: "idle", calls: 0, rows: 0 };
    if (!st.pass_id) {
      st = { ...st, pass_id: now.toISOString(), page: 1, rows_seen: 0 };
      await run(db, "UPDATE accurate_mutation_state SET pass_id = ?, page = 1, rows_seen = 0 WHERE entity = ?", st.pass_id, entity);
    }
    const host = await get<{ host: string | null }>(db, "SELECT host FROM accurate_sync_state WHERE entity = ?", entity);
    client = new AccurateClient(creds, host?.host ?? null, opts.fetchImpl, opts.gapMs);
    let rows = 0;
    while (client.calls < opts.budget && Date.now() < opts.deadline) {
      const res = await client.list<Record<string, unknown>>("item/stock-mutation-history.do", {
        "sp.page": st.page,
        "sp.pageSize": MUTATION_PAGE_SIZE,
        "sp.sort": "id|asc",
      });
      const mapped = res.rows.map(mapMutation).filter((x) => x !== null);
      const last = st.page >= res.pageCount || res.rows.length === 0;
      const seen = st.rows_seen + res.rows.length;
      const stmts = [
        ...(mapped.length ? [stmt(db, UPSERT_SQL, entity, st.pass_id, JSON.stringify(mapped))] : []),
        stmt(db, "UPDATE accurate_mutation_state SET page = ?, rows_seen = ? WHERE entity = ?", st.page + 1, seen, entity),
      ];
      await batch(db, stmts);
      rows += mapped.length;
      st = { ...st, page: st.page + 1, rows_seen: seen };
      if (!last) continue;

      // Pass done. Mark rows gone from Accurate only when every row was read, and never near the 7-day edge.
      let removed = 0;
      if (seen === res.rowCount) {
        const r = await run(
          db,
          `UPDATE stock_mutations SET removed_at = datetime('now')
            WHERE entity = ? AND removed_at IS NULL AND seen_pass IS NOT ? AND created_wib >= ?`,
          entity, st.pass_id, wib(new Date(now.getTime() - 6 * 86_400_000)),
        );
        removed = r.meta.changes;
      }
      await run(
        db,
        "UPDATE accurate_mutation_state SET pass_id = NULL, page = 1, last_pass_at = ?, last_error = NULL, last_error_at = NULL WHERE entity = ?",
        now.toISOString(), entity,
      );
      // Penyesuaian yang baru masuk menutup hitungan "Belum masuk Accurate" yang cocok.
      const entered = await matchEnteredCounts(db, entity);
      return { outcome: "finished", calls: client.calls, rows, removed, entered };
    }
    return { outcome: "progress", calls: client.calls, rows };
  } catch (err) {
    const msg = String((err as Error)?.message ?? err).slice(0, 500);
    await run(db, "UPDATE accurate_mutation_state SET last_error = ?, last_error_at = ? WHERE entity = ?", msg, new Date().toISOString(), entity);
    return { outcome: "error", calls: client?.calls ?? 0, rows: 0, error: msg };
  } finally {
    await run(db, "UPDATE accurate_mutation_state SET locked_until = NULL WHERE entity = ?", entity);
  }
}

/** Cron entry; ACCURATE_MUTATIONS_ENABLED = "false" turns it off, ACCURATE_MUTATIONS_EVERY_HOURS sets the cadence (default 2). */
export async function mutationsTick(env: Bindings, opts: { deadlineMs: number; fetchImpl?: typeof fetch; gapMs?: number }) {
  if (env.ACCURATE_MUTATIONS_ENABLED === "false" || env.ACCURATE_SYNC_ENABLED === "false") return null;
  const entity = catalogEntity(env);
  const creds = credsFor(env, entity);
  if (!creds) return null;
  const h = Number(env.ACCURATE_MUTATIONS_EVERY_HOURS);
  return mutationStep(env.DB, entity, creds, {
    everyHours: Number.isFinite(h) && h > 0 ? Math.min(48, h) : 2,
    budget: syncConfig(env).callsPerTick,
    deadline: Date.now() + opts.deadlineMs,
    fetchImpl: opts.fetchImpl,
    gapMs: opts.gapMs,
  });
}

/** For later screens: one item's movements, newest first. */
export const itemMutations = (db: D1Database, entity: EntityKey, itemNo: string) =>
  all(db, "SELECT * FROM stock_mutations WHERE entity = ? AND item_no = ? ORDER BY created_wib DESC, accurate_id DESC LIMIT 500", entity, itemNo);
