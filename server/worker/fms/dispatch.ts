/* ============================================================
   Sends so_outbox rows to FMS (docs/integrasi-pe-fms.md bagian 1-3).
   Called by the five-minute cron and by waitUntil right after an SO is created,
   cancelled, or resent.

   shortcut: no lease. Cron and waitUntil may pick up the same row at the same
   moment and both send it; FMS stores each eventId (pe_inbox) and answers the
   second one `duplicate: true`, so a double send is harmless. Add a lease only
   if FMS ever stops being idempotent per eventId.
   ============================================================ */

import { all, batch, get, stmt } from "../../db.d1";
import { ackSchema, type Ack } from "../../../shared/fmsContract";
import { auditStmt, salesOrderEnabled, timelineStmt } from "../salesOrderService";
import { allowedTarget, signHex, usableSecret } from "./signing";
import type { Bindings } from "../env";

export const BATCH_SIZE = 20;
export const TIMEOUT_MS = 15_000;
const MAX_BACKOFF_S = 6 * 3600;
/** After this many failed attempts the SO shows "Gagal kirim" (it is still retried). */
const FAIL_AFTER = 3;
const PERMANENT = new Set([400, 401, 413, 422]);

/** Seconds to wait after the n-th failed attempt: 30 s, 60 s, 120 s, ... capped at 6 hours. */
export const backoffSeconds = (attempts: number): number => Math.min(30 * 2 ** Math.max(0, attempts - 1), MAX_BACKOFF_S);

interface OutboxRow {
  id: number;
  event_id: string;
  sales_order_id: number;
  number: string;
  type: string;
  body: string;
  attempts: number;
}

export interface DispatchResult {
  processed: number;
  delivered: number;
  retried: number;
  parked: number;
  skipped?: "disabled" | "config";
}

type Outcome = { kind: "delivered"; ack: Ack } | { kind: "park"; status: number; error: string } | { kind: "retry"; error: string };

export async function dispatchSoOutbox(env: Bindings, fetcher: typeof fetch = fetch): Promise<DispatchResult> {
  const result: DispatchResult = { processed: 0, delivered: 0, retried: 0, parked: 0 };
  const db = env.DB;
  if (!(await salesOrderEnabled(db))) return { ...result, skipped: "disabled" };
  const secret = usableSecret(env.PE_FMS_SECRET);
  if (!secret || !allowedTarget(env.FMS_SO_URL)) {
    // Fail closed: nothing leaves without a real secret and an HTTPS (or local) URL.
    const pending = await get<{ n: number }>(db, "SELECT COUNT(*) AS n FROM so_outbox WHERE delivered_at IS NULL AND parked = 0");
    if (pending?.n) console.error("[fms] PE_FMS_SECRET (>= 32 karakter) atau FMS_SO_URL belum benar; outbox SO tertahan:", pending.n);
    return { ...result, skipped: "config" };
  }
  const url = env.FMS_SO_URL!;

  // Oldest first, and never an event while an earlier one of the same SO is
  // still undelivered: a cancel must not reach FMS before its order. A row held
  // back that way gets its turn in the next round once the earlier one is through.
  for (let round = 0; round < 3 && result.processed < BATCH_SIZE; round++) {
    const rows = await all<OutboxRow>(
      db,
      `SELECT o.id, o.event_id, o.sales_order_id, so.number, o.type, o.body, o.attempts
         FROM so_outbox o JOIN sales_orders so ON so.id = o.sales_order_id
        WHERE o.delivered_at IS NULL AND o.parked = 0 AND o.next_attempt_at <= datetime('now')
          AND NOT EXISTS (SELECT 1 FROM so_outbox p
                           WHERE p.sales_order_id = o.sales_order_id AND p.id < o.id AND p.delivered_at IS NULL)
        ORDER BY o.id LIMIT ?`,
      BATCH_SIZE - result.processed,
    );
    const deliveredBefore = result.delivered;
    for (const row of rows) {
      result.processed++;
      const outcome = await send(fetcher, url, secret, row.body);
      if (outcome.kind === "delivered") {
        await markDelivered(db, row, outcome.ack);
        result.delivered++;
      } else if (outcome.kind === "park") {
        await markParked(db, row, outcome.status, outcome.error);
        result.parked++;
      } else {
        await markRetry(db, row, outcome.error);
        result.retried++;
      }
    }
    if (result.delivered === deliveredBefore) break;
  }
  return result;
}

async function send(fetcher: typeof fetch, url: string, secret: string, body: string): Promise<Outcome> {
  const ts = String(Math.floor(Date.now() / 1000));
  let res: Response;
  try {
    res = await fetcher(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-pe-timestamp": ts, "x-pe-signature": await signHex(secret, `${ts}.${body}`) },
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    return { kind: "retry", error: `Jaringan: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500) };
  }
  const text = (await res.text().catch(() => "")).slice(0, 2000);
  if (res.status === 200) {
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON: an invalid ack, retried below */
    }
    const ack = ackSchema.safeParse(json);
    if (ack.success) return { kind: "delivered", ack: ack.data };
    return { kind: "retry", error: `HTTP 200 tanpa ack yang sah: ${text.slice(0, 200)}` };
  }
  const error = `HTTP ${res.status}: ${text.slice(0, 300)}`;
  return PERMANENT.has(res.status) ? { kind: "park", status: res.status, error } : { kind: "retry", error };
}

async function markDelivered(db: D1Database, row: OutboxRow, ack: Ack) {
  const notApplied = !ack.applied ? ack.reason || "FMS tidak menjalankan event ini." : null;
  const statements = [
    stmt(db, "UPDATE so_outbox SET delivered_at = datetime('now'), last_error = NULL WHERE id = ?", row.id),
    stmt(
      db,
      "UPDATE sales_orders SET sync_state = 'delivered', sync_error = ?, updated_at = datetime('now') WHERE id = ?",
      notApplied, row.sales_order_id,
    ),
    timelineStmt(db, row.number, "sent", { type: row.type, applied: ack.applied, duplicate: ack.duplicate, reason: ack.reason ?? null }),
  ];
  if (row.type === "sales_order.cancel_requested" && !ack.applied) {
    // FMS refused the cancel (e.g. already handed over): the SO is active again.
    statements.push(
      stmt(db, "UPDATE sales_orders SET status = 'open', updated_at = datetime('now') WHERE id = ? AND status = 'cancel_requested'", row.sales_order_id),
      timelineStmt(db, row.number, "cancel_rejected", { reason: notApplied }),
      auditStmt(db, null, row.number, "cancel_rejected", { reason: notApplied }),
    );
  }
  await batch(db, statements);
}

async function markParked(db: D1Database, row: OutboxRow, status: number, error: string) {
  const statements = [
    stmt(db, "UPDATE so_outbox SET parked = 1, attempts = attempts + 1, last_error = ? WHERE id = ?", error, row.id),
    stmt(db, "UPDATE sales_orders SET sync_state = 'failed', sync_error = ?, updated_at = datetime('now') WHERE id = ?", error, row.sales_order_id),
    timelineStmt(db, row.number, "sync_failed", { type: row.type, error, parked: true }),
  ];
  if (status === 401) {
    // Admin warning: almost always PE_FMS_SECRET differs between the two apps.
    console.error(`[fms] PERINGATAN ADMIN: FMS menolak tanda tangan PE (401) untuk ${row.number}. Cek PE_FMS_SECRET di kedua aplikasi.`);
    statements.push(auditStmt(db, null, row.number, "fms_auth_rejected", { error }));
  }
  await batch(db, statements);
}

async function markRetry(db: D1Database, row: OutboxRow, error: string) {
  const attempts = row.attempts + 1;
  const statements = [
    stmt(
      db,
      "UPDATE so_outbox SET attempts = ?, last_error = ?, next_attempt_at = datetime('now', ?) WHERE id = ?",
      attempts, error, `+${backoffSeconds(attempts)} seconds`, row.id,
    ),
  ];
  if (attempts >= FAIL_AFTER) {
    statements.push(
      stmt(db, "UPDATE sales_orders SET sync_state = 'failed', sync_error = ?, updated_at = datetime('now') WHERE id = ?", error, row.sales_order_id),
    );
    if (attempts === FAIL_AFTER) statements.push(timelineStmt(db, row.number, "sync_failed", { type: row.type, error, parked: false }));
  }
  await batch(db, statements);
}
