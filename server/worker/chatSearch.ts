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
import { PRIORITY_BRAND_SQL, splitBrandQuery } from "../../shared/priorityBrands";

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
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (s.q) {
    // A priority brand in any spelling ("vtec", "art line") matches every way the catalog writes it.
    const { catalog, rest } = splitBrandQuery(s.q);
    if (catalog) {
      where.push(`(${catalog.map(() => (catalog[0] === "GM" ? "(' ' || UPPER(c.name) || ' ') LIKE ?" : "UPPER(c.name) LIKE ?")).join(" OR ")})`);
      params.push(...catalog.map((w) => (w === "GM" ? "% GM %" : `%${w}%`)));
    }
    if (!catalog || /\p{L}/u.test(rest)) {
      where.push("(c.name LIKE ? OR c.code LIKE ?)");
      params.push(`%${rest}%`, `%${rest}%`);
    }
  }
  if (s.cogsMin !== undefined) where.push("c.cogs >= ?"), params.push(s.cogsMin);
  if (s.cogsMax !== undefined) where.push("c.cogs <= ?"), params.push(s.cogsMax);
  if (s.stockMax !== undefined) where.push("c.stock <= ?"), params.push(s.stockMax);
  if (s.kind === "cogs_problem") where.push(PROBLEM_SQL), params.push(COGS_JUMP);
  const from = `FROM catalog_items c LEFT JOIN catalog_cogs_baseline b ON b.code = c.code ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`;

  const rows = await all<{ code: string; name: string; uom: string; stock: number; cogs: number; list_price: number; reference: number | null }>(
    db,
    `SELECT c.code, c.name, c.uom, c.stock, c.cogs, c.list_price, b.cogs AS reference ${from} ORDER BY ${PRIORITY_BRAND_SQL} DESC, c.name LIMIT ?`,
    ...params,
    SEARCH_LIMIT,
  );
  const items = rows.map((r): FoundRow => {
    const base = { code: r.code, name: r.name, uom: r.uom, stock: r.stock };
    if (!canSeeCosts) return base;
    const problem = cogsProblem(r, r.reference);
    return { ...base, cogs: r.cogs, ...(problem ? { problem } : {}) };
  });
  // Each query scans the catalog (~7k rows of the D1 daily read budget): count only when the page is full.
  const total = rows.length < SEARCH_LIMIT ? rows.length : ((await get<{ n: number }>(db, `SELECT COUNT(*) AS n ${from}`, ...params))?.n ?? rows.length);
  return { kind: s.kind, total, items };
}
