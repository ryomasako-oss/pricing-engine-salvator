/* Rekap Accurate pagi (Ryoma, 2026-10-15): managers and admins get one email
   with Silvy's summary of what the latest Accurate goods receipts would change
   in catalog COGS, what was skipped, and the catalog cross-check
   (shared/accurateRecap.ts builds the recap, the prompt and the email).

   Runs in the 08:00 WIB digest cron next to "Perlu diperbaiki". Cost: at most
   one Silvy (Gemini) call a day, none on a day with nothing to act on, and
   still an email when Silvy is off or fails (the numbers come from here). */

import { all, get, getSetting, setSetting } from "../db.d1";
import { buildRecap, recapEmail, recapIsEmpty } from "../../shared/accurateRecap";
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
  const recap = buildRecap({
    now: opts.now,
    entity,
    receipts: { lastPassAt: st.last_pass_at, inProgress: !!st.pass_started_at, receiptsSeen: st.receipts_seen },
    preview,
    counts,
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
    silvy: narrative ? "ok" : "failed",
    ...(error ? { error: error.slice(0, 200) } : {}),
  });
  return { sent: recipients.length, silvy: narrative ? "ok" : "failed", ...(error ? { error } : {}) };
}
