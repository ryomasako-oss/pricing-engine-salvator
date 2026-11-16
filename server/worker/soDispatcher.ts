/* ============================================================
   Pricing Engine — Sales Order Outbox Dispatcher
   Periodically delivers pending outbox events to FMS Webhook.
   ============================================================ */

import { all, stmt, batch } from "../db.d1";
import type { Bindings } from "./env";

interface DbOutboxRow {
  id: string;
  event_id: string;
  event_type: string;
  payload_json: string;
  status: string;
  attempts: number;
}

export const SO_DISPATCH_CRON = "*/2 * * * *"; // Every 2 minutes

const BACKOFF_MINUTES = [1, 5, 15, 60, 360, 1440]; // 1m, 5m, 15m, 1h, 6h, 24h

export function computeNextAttempt(attempts: number, baseDate = new Date()): Date {
  const index = Math.min(attempts, BACKOFF_MINUTES.length - 1);
  const minutes = BACKOFF_MINUTES[index] ?? 1440;
  return new Date(baseDate.getTime() + minutes * 60 * 1000);
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function dispatchSoOutbox(
  env: Bindings,
  options: { limit?: number; now?: Date; fetchFn?: typeof fetch } = {},
): Promise<{ processed: number; delivered: number; failed: number }> {
  const d1 = env.DB;
  const fmsUrl = env.FMS_URL || "http://localhost:3000";
  const secret = env.FMS_WEBHOOK_SECRET || "salvator-secret-key";
  const fetcher = options.fetchFn || fetch;
  const now = options.now || new Date();
  const nowIso = now.toISOString();

  // Cek feature flag sales_order_enabled di settings
  const settingRow = await d1
    .prepare("SELECT value FROM settings WHERE key = 'sales_order_enabled'")
    .first<{ value: string }>();
  if (settingRow && settingRow.value === "0") {
    return { processed: 0, delivered: 0, failed: 0 };
  }

  const limit = options.limit || 10;
  const rows = await all<DbOutboxRow>(
    d1,
    `SELECT id, event_id, event_type, payload_json, status, attempts
     FROM so_outbox
     WHERE status = 'PENDING' AND next_attempt_at <= ?
     ORDER BY created_at ASC
     LIMIT ?`,
    nowIso,
    limit,
  );

  let deliveredCount = 0;
  let failedCount = 0;

  for (const row of rows) {
    const rawBody = row.payload_json;
    const signature = await hmacSha256Hex(secret, rawBody);
    const endpoint = `${fmsUrl.replace(/\/+$/, "")}/api/webhooks/pricing-engine`;

    try {
      const response = await fetcher(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Signature-SHA256": signature,
          "X-Timestamp": nowIso,
          "X-Event-Id": row.event_id,
          "X-Event-Type": row.event_type,
        },
        body: rawBody,
      });

      if (response.ok) {
        await stmt(
          d1,
          `UPDATE so_outbox
           SET status = 'DELIVERED',
               delivered_at = ?,
               attempts = attempts + 1
           WHERE id = ?`,
          nowIso,
          row.id,
        ).run();
        deliveredCount++;
      } else {
        const errorText = await response.text().catch(() => "");
        const nextAttempts = row.attempts + 1;
        const isDead = nextAttempts >= 6;
        const nextDate = computeNextAttempt(nextAttempts, now).toISOString();

        await stmt(
          d1,
          `UPDATE so_outbox
           SET status = ?,
               attempts = ?,
               next_attempt_at = ?,
               last_error = ?
           WHERE id = ?`,
          isDead ? "DEAD" : "PENDING",
          nextAttempts,
          nextDate,
          `HTTP ${response.status}: ${errorText.slice(0, 300)}`,
          row.id,
        ).run();
        failedCount++;
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const nextAttempts = row.attempts + 1;
      const isDead = nextAttempts >= 6;
      const nextDate = computeNextAttempt(nextAttempts, now).toISOString();

      await stmt(
        d1,
        `UPDATE so_outbox
         SET status = ?,
             attempts = ?,
             next_attempt_at = ?,
             last_error = ?
         WHERE id = ?`,
        isDead ? "DEAD" : "PENDING",
        nextAttempts,
        nextDate,
        `Network error: ${message.slice(0, 300)}`,
        row.id,
      ).run();
      failedCount++;
    }
  }

  return {
    processed: rows.length,
    delivered: deliveredCount,
    failed: failedCount,
  };
}
