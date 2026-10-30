/* Rekap Accurate pagi (Ryoma, 2026-10-15): managers and admins get one email
   with Silvy's summary of what the latest Accurate goods receipts would change
   in catalog COGS, what was skipped, and the catalog cross-check
   (shared/accurateRecap.ts builds the recap, the prompt and the email).

   Runs in the 08:00 WIB digest cron next to "Perlu diperbaiki". Cost: at most
   one Silvy (Gemini) call a day, none on a day with nothing to act on, and
   still an email when Silvy is off or fails (the numbers come from here). */

import { all, batch, get, getSetting, setSetting, stmt } from "../db.d1";
import { STOCK_TOP, buildRecap, recapEmail, recapIsEmpty } from "../../shared/accurateRecap";
import { STOCK_AS_OF_KEY } from "./accurate/stock";
import { forwardToSilvy, silvyConfigFrom } from "../silvy";
import { applyPurchaseCosts } from "./accurate/purchaseCost";
import { loadReceiptState, receiptsEnabled } from "./accurate/receipts";
import { reconcileCounts } from "./accurate/reconcile";
import { catalogEntity } from "./accurate/sync";
import { audit } from "./audit";
import { MAX_RECIPIENTS } from "./fixDigest";
import { currentPolicy } from "./quoteService";
import type { Bindings } from "./env";

const LAST_KEY = "accurate_recap_last";
const wibDate = (now: Date) => new Date(now.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);

export type RecapOutcome =
  | { skipped: "disabled" | "already-sent-today" | "nothing-to-report" }
  | { sent: number; silvy: "ok" | "failed"; error?: string };

export async function runAccurateRecap(
  env: Bindings,
  opts: { now: Date; link: string; send: (to: string, subject: string, html: string) => Promise<void>; fetchImpl?: typeof fetch },
): Promise<RecapOutcome> {
  const db = env.DB;
  if (!receiptsEnabled(env)) return { skipped: "disabled" };
  const today = wibDate(opts.now);
  if ((await getSetting(db, LAST_KEY, "")) === today) return { skipped: "already-sent-today" };

  const entity = catalogEntity(env);
  const st = await loadReceiptState(db, entity);
  // The preview reads every stored receipt line once: here, once a day, never per tick.
  const preview = st.last_pass_at ? await applyPurchaseCosts(db, entity, { dryRun: true }) : null;
  const staged = await get<{ n: number }>(db, "SELECT COUNT(*) AS n FROM accurate_items WHERE entity = ?", entity);
  const counts = staged?.n ? await reconcileCounts(db, entity) : null;
  // Items the cron added on their own since yesterday's recap (accurate/newItems.ts).
  const newItems = await all<{ code: string; name: string }>(
    db,
    `SELECT c.code, c.name FROM catalog_items c
      WHERE c.code IN (SELECT j.value FROM audit_log a, json_each(a.detail, '$.codes') j
                        WHERE a.action = 'accurate_new_items' AND a.created_at >= datetime(?, '-1 day'))
      ORDER BY c.code`,
    opts.now.toISOString().slice(0, 19).replace("T", " "),
  );
  // One row: whether the 5-minute item/stock sync is stuck (absent: never set up).
  const sync = await get<{ last_success_at: string | null; last_error: string | null }>(
    db,
    "SELECT last_success_at, last_error FROM accurate_sync_state WHERE entity = ?",
    entity,
  );
  // Catalog stock as sales see it, only once a completed run has refreshed it (accurate/stock.ts).
  const [stockTotals, negative] = await batch(db, [
    stmt(
      db,
      `SELECT (SELECT value FROM settings WHERE key = ?) AS as_of, COALESCE(SUM(stock > 0), 0) AS in_stock,
              COALESCE(SUM(stock = 0), 0) AS empty, COALESCE(SUM(stock < 0), 0) AS negative
         FROM catalog_items`,
      STOCK_AS_OF_KEY,
    ),
    stmt(db, `SELECT code, name, stock AS qty FROM catalog_items WHERE stock < 0 ORDER BY stock, code LIMIT ${STOCK_TOP}`),
  ]);
  const totals = stockTotals.results[0] as { as_of: string | null; in_stock: number; empty: number; negative: number } | undefined;
  const stock = totals?.as_of
    ? {
        asOf: totals.as_of,
        inStock: totals.in_stock,
        empty: totals.empty,
        negative: totals.negative,
        topNegative: negative.results as { code: string; name: string; qty: number }[],
      }
    : null;
  const recap = buildRecap({
    now: opts.now,
    entity,
    receipts: { lastPassAt: st.last_pass_at, inProgress: !!st.pass_started_at, receiptsSeen: st.receipts_seen },
    preview,
    counts,
    newItems,
    sync,
    stock,
  });

  // Marked before Silvy and the send, like the fix digest: a missed email beats a double one.
  await setSetting(db, LAST_KEY, today);
  if (recapIsEmpty(recap)) return { skipped: "nothing-to-report" };

  const reply = await forwardToSilvy(
    silvyConfigFrom(env as unknown as Record<string, string | undefined>),
    "report",
    { recap },
    await currentPolicy(db),
    opts.fetchImpl,
  );
  const narrative = reply.status === 200 && typeof reply.body.content === "string" && reply.body.content.trim() ? reply.body.content : null;
  const error = narrative ? undefined : String(reply.body.error ?? `Silvy ${reply.status}`);

  const mail = recapEmail(recap, narrative, opts.link);
  const recipients = await all<{ email: string }>(
    db,
    `SELECT email FROM users WHERE role IN ('manager', 'admin') AND active = 1 AND email <> ''
      ORDER BY role DESC, id LIMIT ${MAX_RECIPIENTS}`,
  );
  if (recipients.length) await opts.send(recipients.map((r) => r.email).join(", "), mail.subject, mail.html);
  await audit(db, null, "accurate", 0, "recap_sent", {
    date: today,
    recipients: recipients.length,
    changed: recap.cogs.changed,
    newItems: recap.newItems?.added ?? 0,
    silvy: narrative ? "ok" : "failed",
    ...(error ? { error: error.slice(0, 200) } : {}),
  });
  return { sent: recipients.length, silvy: narrative ? "ok" : "failed", ...(error ? { error } : {}) };
}
