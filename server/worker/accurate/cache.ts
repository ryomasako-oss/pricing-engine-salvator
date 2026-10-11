/* Short-lived cache for the panel's aggregate queries.

   The Katalog panel polled /accurate/status and /accurate/flags every 15 s
   while a sync ran. Each call recounted the whole staged catalogue (7,096 items
   plus thousands of stock rows): 5,000 to 18,000 rows read per call, about 7.9
   million rows in a day, which used up D1's Free daily read allowance for the
   whole account and made every query in the app fail until midnight UTC.

   Results are kept in the settings table with a timestamp. A hit costs one row;
   only the first call after the TTL recomputes. `fresh` skips the cache for
   actions that just changed the data (a sync or an apply from the panel). */

import { getSetting, setSetting } from "../../db.d1";

interface Entry<T> {
  at: number;
  value: T;
}

export const COUNTS_TTL_MS = 5 * 60_000;
export const FLAGS_TTL_MS = 10 * 60_000;

export async function cachedFor<T>(
  db: D1Database,
  key: string,
  ttlMs: number,
  compute: () => Promise<T>,
  opts: { fresh?: boolean; now?: number } = {},
): Promise<T> {
  const now = opts.now ?? Date.now();
  if (!opts.fresh) {
    const hit = await getSetting<Entry<T> | null>(db, key, null);
    if (hit && typeof hit.at === "number" && now - hit.at >= 0 && now - hit.at < ttlMs) return hit.value;
  }
  const value = await compute();
  await setSetting(db, key, { at: now, value } satisfies Entry<T>);
  return value;
}
