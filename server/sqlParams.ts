/* Numbered placeholders (?1, ?2, ...) rewritten to plain "?" with the
   parameters reordered to match. D1 and newer node:sqlite accept ?N, but
   node:sqlite before Node 22.15 treats ?N as a named parameter and refuses
   positional values for it ("column index out of range"). The D1 shim
   (scripts/d1-sqlite-shim.ts) passes its SQL through here, so the
   Worker's SQL may use ?N in tests on every supported Node (>=22.5). */

export type SqlParam = string | number | null | bigint | Uint8Array;

export function positional<P>(sql: string, params: P[]): { sql: string; params: P[] } {
  // Mixed "?" and "?N" in one statement is left alone: SQLite's own numbering applies.
  if (!/\?\d/.test(sql) || /\?(?!\d)/.test(sql)) return { sql, params };
  const out: P[] = [];
  const rewritten = sql.replace(/\?(\d+)/g, (_, n: string) => {
    out.push(params[Number(n) - 1]);
    return "?";
  });
  return { sql: rewritten, params: out };
}

/** Splits a list for IN (...) lookups: D1 binds at most 100 parameters per statement. */
export function chunks<T>(xs: T[], n = 90): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}
