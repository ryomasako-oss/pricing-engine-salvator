/* ============================================================
   Server side of the COGS sanity check (shared/cogsCheck.ts), shared by the
   Express and Worker backends: the SQL they run and what they decide from
   the rows. Each backend only supplies the database call.
   ============================================================ */

import { z } from "zod";
import { cogsProblem } from "../shared/cogsCheck.js";
import { normalizeCode } from "../shared/duplicates.js";
import type { QuoteItem } from "../shared/types.js";

export const cogsCheckInput = z.object({ codes: z.array(z.string().max(64)).max(2000) });

export interface CogsRow {
  code: string;
  cogs: number;
  list_price: number;
  /** Reference COGS (catalog_cogs_baseline), null when the item never had one. */
  reference: number | null;
}

/**
 * Lookup keys for these codes (normalizeCode: trimmed, lowercase), de-duplicated.
 * A line's code is not always the catalog's spelling: a client's file keeps
 * "atk-0101" or "ATK-0101 " as typed, and an exact lookup let those lines
 * skip the block.
 */
export const cogsLookupKeys = (codes: string[]) => [...new Set(codes.map(normalizeCode).filter(Boolean))];

/** Catalog facts plus reference COGS for the given lookup keys (`?` placeholders, one per key). */
export const cogsRowsSql = (n: number) => `
  SELECT c.code, c.cogs, c.list_price, b.cogs AS reference
    FROM catalog_items c
    LEFT JOIN catalog_cogs_baseline b ON b.code = c.code
   WHERE lower(trim(c.code)) IN (${Array.from({ length: n }, () => "?").join(",")})`;

/** A manager confirms the current COGS: it becomes the reference. */
export const VERIFY_COGS_SQL = `
  INSERT INTO catalog_cogs_baseline(code, cogs) VALUES(?, ?)
  ON CONFLICT(code) DO UPDATE SET cogs = excluded.cogs`;

/**
 * Requested code -> problem, for problematic codes only. Keyed by each code
 * exactly as the caller passed it, so a quote line or a cogs-check request
 * finds its answer under its own spelling.
 */
export function problemsByCode(requested: string[], rows: CogsRow[]): Map<string, string> {
  const byKey = new Map<string, string>();
  for (const r of rows) {
    const problem = cogsProblem(r, r.reference);
    const key = normalizeCode(r.code);
    if (problem && !byKey.has(key)) byKey.set(key, problem);
  }
  const out = new Map<string, string>();
  for (const code of requested) {
    const problem = byKey.get(normalizeCode(code));
    if (problem) out.set(code, problem);
  }
  return out;
}

/** Each catalog item with its problem (or null) attached, for list/match responses. */
export function withProblems<T extends { code: string }>(items: T[], problems: Map<string, string>) {
  return items.map((it) => ({ ...it, cogs_problem: problems.get(it.code) ?? null }));
}

/** Statuses whose holds follow the catalog live; from submit on they stay as frozen. */
const LIVE_HOLD_STATUSES = new Set(["draft", "rejected"]);

/**
 * A quote with each line's hold set from the catalog (meeting 2026-10-05 #6,
 * Ryoma 2026-10-06): a line whose catalog COGS has a problem is held, not
 * offered, totalled or checked against policy, while the rest of the quote
 * goes ahead. While the quote is editable this follows the catalog, so a fixed
 * or confirmed COGS releases the line; once submitted the holds stay as they
 * were, so an approved document never changes by itself.
 */
export function applyHolds<T extends { status: string; items: QuoteItem[] }>(quote: T, problems: Map<string, string>): T {
  if (!LIVE_HOLD_STATUSES.has(quote.status)) return quote;
  return {
    ...quote,
    items: quote.items.map(({ held: _h, ...it }) => (it.code && problems.has(it.code) ? { ...it, held: true } : it)),
  };
}

/** Codes on quotes whose holds follow the catalog, for one problem lookup over a list. */
export const liveHoldCodes = (quotes: { status: string; items: QuoteItem[] }[]) =>
  quotes.filter((q) => LIVE_HOLD_STATUSES.has(q.status)).flatMap((q) => q.items.map((it) => it.code));

export const ALL_HELD =
  "Semua item ditahan karena COGS-nya perlu dicek manajer, jadi belum ada yang bisa diajukan.";
