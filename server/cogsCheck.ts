/* ============================================================
   Server side of the COGS sanity check (shared/cogsCheck.ts), shared by the
   Express and Worker backends: the SQL they run and what they decide from
   the rows. Each backend only supplies the database call.
   ============================================================ */

import { z } from "zod";
import { cogsProblem } from "../shared/cogsCheck.js";
import type { QuoteItem } from "../shared/types.js";

export const cogsCheckInput = z.object({ codes: z.array(z.string().max(64)).max(2000) });

export interface CogsRow {
  code: string;
  cogs: number;
  list_price: number;
  /** Reference COGS (catalog_cogs_baseline), null when the item never had one. */
  reference: number | null;
}

/** Catalog facts plus reference COGS for the given codes (`?` placeholders, one per code). */
export const cogsRowsSql = (n: number) => `
  SELECT c.code, c.cogs, c.list_price, b.cogs AS reference
    FROM catalog_items c
    LEFT JOIN catalog_cogs_baseline b ON b.code = c.code
   WHERE c.code IN (${Array.from({ length: n }, () => "?").join(",")})`;

/** A manager confirms the current COGS: it becomes the reference. */
export const VERIFY_COGS_SQL = `
  INSERT INTO catalog_cogs_baseline(code, cogs) VALUES(?, ?)
  ON CONFLICT(code) DO UPDATE SET cogs = excluded.cogs`;

/** code -> problem, for problematic codes only. */
export function problemsByCode(rows: CogsRow[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of rows) {
    const problem = cogsProblem(r, r.reference);
    if (problem) out.set(r.code, problem);
  }
  return out;
}

/** Each catalog item with its problem (or null) attached, for list/match responses. */
export function withProblems<T extends { code: string }>(items: T[], problems: Map<string, string>) {
  return items.map((it) => ({ ...it, cogs_problem: problems.get(it.code) ?? null }));
}

/** Quote lines whose catalog item has a COGS problem. Lines not from the catalog are left to the pricing policy. */
export function blockedLines(items: QuoteItem[], problems: Map<string, string>) {
  return items
    .filter((it) => it.code && problems.has(it.code))
    .map((it) => ({ lineNo: it.lineNo, code: it.code, name: it.name, problem: problems.get(it.code)! }));
}

export const blockedMessage = (lines: { lineNo: number; name: string }[]) =>
  `${lines.length} item memakai COGS katalog yang tidak wajar dan tidak boleh dijual: ` +
  lines.slice(0, 5).map((l) => `baris ${l.lineNo} ${l.name}`).join(", ") +
  (lines.length > 5 ? ", …" : "") +
  ". Perbaiki COGS di katalog (atau minta manajer menandai sudah dicek), lalu ajukan lagi.";
