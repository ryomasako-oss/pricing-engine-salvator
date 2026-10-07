/* The morning "Perlu diperbaiki" email (Ryoma 2026-10-06): managers and
   admins get every open task, oldest first. Runs on its own cron entry
   (wrangler.toml), not inside the 5-minute Accurate tick, which already
   uses most of the Free plan's 50 subrequests per invocation.

   Subrequests: 4 D1 queries + 2 per email (Gmail token + send), with at
   most MAX_RECIPIENTS emails -> 24 at most (fixDigest.test.ts counts). */

import { all, getSetting, setSetting } from "../db.d1";
import { digestEmail, type OpenTaskRow } from "../../shared/fixTasks";
import { OPEN_TASKS_FOR_DIGEST_SQL } from "../fixTasks";

/** 01:00 UTC = 08:00 WIB. Must match the second entry of [triggers] crons. */
export const DIGEST_CRON = "0 1 * * *";
export const MAX_RECIPIENTS = 10;
const LAST_KEY = "fix_digest_last";

/** Jakarta calendar date, so a retry later the same morning is recognised. */
const wibDate = (now: Date) => new Date(now.getTime() + 7 * 3_600_000).toISOString().slice(0, 10);

export async function runFixDigest(
  db: D1Database,
  opts: { now: Date; link: string; send: (to: string, subject: string, html: string) => Promise<void> },
): Promise<{ open: number; sent: number; skipped?: "already-sent-today" }> {
  const today = wibDate(opts.now);
  if ((await getSetting(db, LAST_KEY, "")) === today) return { open: 0, sent: 0, skipped: "already-sent-today" };
  const tasks = await all<OpenTaskRow>(db, OPEN_TASKS_FOR_DIGEST_SQL);
  // Marked before sending: if a send fails or the cron retries, a missed email
  // is better than the same list arriving twice.
  await setSetting(db, LAST_KEY, today);
  const mail = digestEmail(tasks, opts.now, opts.link);
  if (!mail) return { open: 0, sent: 0 };
  const recipients = await all<{ email: string }>(
    db,
    `SELECT email FROM users WHERE role IN ('manager', 'admin') AND active = 1 AND email <> ''
      ORDER BY role DESC, id LIMIT ${MAX_RECIPIENTS}`,
  );
  // One email to all of them: each send signs a Google token, and doing that
  // per recipient could pass the Free plan's 10 ms CPU limit; a CPU kill here
  // would lose the day's digest, since the day is already marked as sent.
  if (recipients.length) await opts.send(recipients.map((r) => r.email).join(", "), mail.subject, mail.html);
  return { open: tasks.length, sent: recipients.length };
}
