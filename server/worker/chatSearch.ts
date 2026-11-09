/* ============================================================
   Catalog lookups asked for in the Home chat ("barang COGS sekitar 20 ribu",
   "stok kertas A4", "barang yang COGS-nya bermasalah").

   The model only fills a fixed filter (ChatSearch); this file runs it as a
   parameterized query and the rows go straight to the browser, never back
   to the model, so no number in the table can be invented. The cost gate is
   here, on the server: without view_costs a cost filter is refused and the
   rows carry no COGS at all (same rule as catalogItemsForViewer).
   ============================================================ */

import { all, get } from "../db.d1";
import { COGS_JUMP, cogsProblem } from "../../shared/cogsCheck";
import type { ChatSearch } from "../chat";
import { PRIORITY_BRAND_SQL } from "../../shared/priorityBrands";
import { searchItems } from "./catalogSearchIndex";

export const SEARCH_LIMIT = 20;

export interface FoundRow {
  code: string;
  name: string;
  uom: string;
  stock: number;
  cogs?: number;
  problem?: string;
}

export type ChatFound = { kind: ChatSearch["kind"]; total: number; items: FoundRow[] } | { denied: true };

/** Whether this search needs cost access: any COGS filter, or the COGS-problem list. */
export const needsCosts = (s: ChatSearch) => s.kind === "cogs_problem" || s.cogsMin !== undefined || s.cogsMax !== undefined;

// Same three signs as shared/cogsCheck.ts cogsProblem, in SQL so the list can be paged.
const PROBLEM_SQL = `(c.cogs <= 0 OR (c.list_price > 0 AND c.cogs > c.list_price) OR (b.cogs > 0 AND abs(c.cogs - b.cogs) > ? * b.cogs))`;

export async function runChatSearch(db: D1Database, s: ChatSearch, canSeeCosts: boolean): Promise<ChatFound> {
  if (needsCosts(s) && !canSeeCosts) return { denied: true };
  type Row = { code: string; name: string; uom: string; stock: number; cogs: number; list_price: number; reference: number | null };
  const columns = "c.code, c.name, c.uom, c.stock, c.cogs, c.list_price, b.cogs AS reference";
  const join = "FROM catalog_items c LEFT JOIN catalog_cogs_baseline b ON b.code = c.code";
  let rows: Row[];
  let total: number;
  if (s.q) {
    // Ranked by the shared catalog search (shared/catalogSearch.ts): any word order, synonyms, typos,
    // brands in any spelling, priority categories first. The filters then apply to that order.
    const found = await searchItems(db, s.q);
    // A chat answer lists matches only: items missing one of the words are not offered as if they matched.
    let ranked = (found.partial ? [] : found.items).filter(
      (r) =>
        (s.cogsMin === undefined || r.cogs >= s.cogsMin) &&
        (s.cogsMax === undefined || r.cogs <= s.cogsMax) &&
        (s.stockMax === undefined || r.stock <= s.stockMax),
    );
    if (s.kind === "cogs_problem") {
      const bad = new Set((await all<{ code: string }>(db, `SELECT c.code ${join} WHERE ${PROBLEM_SQL}`, COGS_JUMP)).map((r) => r.code));
      ranked = ranked.filter((r) => bad.has(r.code));
    }
    total = ranked.length;
    const page = ranked.slice(0, SEARCH_LIMIT).map((r) => r.code);
    const got = page.length
      ? await all<Row>(db, `SELECT ${columns} ${join} WHERE c.code IN (${page.map(() => "?").join(",")})`, ...page)
      : [];
    const byCode = new Map(got.map((r) => [r.code, r]));
    rows = page.map((code) => byCode.get(code)).filter((r): r is Row => !!r);
  } else {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (s.cogsMin !== undefined) where.push("c.cogs >= ?"), params.push(s.cogsMin);
    if (s.cogsMax !== undefined) where.push("c.cogs <= ?"), params.push(s.cogsMax);
    if (s.stockMax !== undefined) where.push("c.stock <= ?"), params.push(s.stockMax);
    if (s.kind === "cogs_problem") where.push(PROBLEM_SQL), params.push(COGS_JUMP);
    const from = `${join} ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`;
    rows = await all<Row>(db, `SELECT ${columns} ${from} ORDER BY ${PRIORITY_BRAND_SQL} DESC, c.name LIMIT ?`, ...params, SEARCH_LIMIT);
    // Each query scans the catalog (~7k rows of the D1 daily read budget): count only when the page is full.
    total = rows.length < SEARCH_LIMIT ? rows.length : ((await get<{ n: number }>(db, `SELECT COUNT(*) AS n ${from}`, ...params))?.n ?? rows.length);
  }
  const items = rows.map((r): FoundRow => {
    const base = { code: r.code, name: r.name, uom: r.uom, stock: r.stock };
    if (!canSeeCosts) return base;
    const problem = cogsProblem(r, r.reference);
    return { ...base, cogs: r.cogs, ...(problem ? { problem } : {}) };
  });
  return { kind: s.kind, total, items };
}
