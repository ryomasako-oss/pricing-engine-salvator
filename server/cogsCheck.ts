/* ============================================================
   Server side of the COGS sanity check (shared/cogsCheck.ts), shared by the
   Express and Worker backends: the SQL they run and what they decide from
   the rows. Each backend only supplies the database call.
   ============================================================ */

import { z } from "zod";
import { cogsProblem } from "../shared/cogsCheck.js";
import { normalizeCode } from "../shared/duplicates.js";
import type { CatalogItem, QuoteItem } from "../shared/types.js";
import { priceUnitOf, unitFactor } from "../shared/uom.js";

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
  const byKey = new Map<string, CogsRow[]>();
  for (const r of rows) byKey.set(normalizeCode(r.code), [...(byKey.get(normalizeCode(r.code)) ?? []), r]);
  const out = new Map<string, string>();
  for (const code of requested) {
    const variants = byKey.get(normalizeCode(code)) ?? [];
    // Codes are unique only with exact case: the exact row answers for itself.
    // Without one, any case-variant's problem counts, since which is meant is unclear.
    const exact = variants.find((r) => r.code === code);
    const problem = exact
      ? cogsProblem(exact, exact.reference)
      : variants.map((r) => cogsProblem(r, r.reference)).find(Boolean) ?? null;
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
export function applyHolds<T extends { status: string; items: QuoteItem[] }>(
  quote: T,
  problems: Map<string, string>,
  catalog: Map<string, CatalogItem[]> = new Map(),
): T {
  if (!LIVE_HOLD_STATUSES.has(quote.status)) return quote;
  return {
    ...quote,
    items: quote.items.map(({ held: _h, ...it }) => {
      if (it.code && problems.has(it.code)) return { ...it, held: true };
      const rows = it.code ? catalog.get(normalizeCode(it.code)) ?? [] : [];
      if (!rows.length) return it; // not from the catalog: left to the pricing policy, as before
      // Codes are unique only with exact case: use the exact one. When only
      // case-variants of the line's code exist, which item is meant can't be
      // told, so the line waits for a manager instead of taking either's cost.
      const item = rows.find((r) => r.code === it.code) ?? (rows.length === 1 ? rows[0] : undefined);
      if (!item) return { ...it, held: true };
      return followCatalog(it, catalogCostIn(item, it));
    }),
  };
}

/**
 * A draft line's cost against the catalog's current COGS (`current`, in the
 * line's unit; null when no ratio converts it). A held line released after
 * its catalog COGS was fixed must not keep the number it was held for: with
 * a price of 150, a stale COGS of 100 against a real 1,000 auto-approved.
 *
 * - No real cost yet (0, or estimated from a client's file): take the catalog's.
 * - A cost someone typed or imported (cogsByHand, or cogs differing from the
 *   catalogCogs it was copied from): keep it.
 * - Still the catalog copy it was made with (cogs === catalogCogs): follow the catalog.
 * - No record (a line from before catalogCogs): adopt the record when the cost
 *   matches (allowing for the whole-rupiah rounding lines used to get, scaled
 *   by the unit); otherwise it may be a stale copy of a wrong COGS, so it stays
 *   held until someone types its cost or re-adds it from the catalog.
 * - No ratio to compare with: held, unless the cost was typed.
 */
function followCatalog(it: QuoteItem, current: { cost: number; factor: number } | null): QuoteItem {
  const placeholder = !(Number(it.cogs) > 0) || Boolean(it.estCogs);
  const typed = !placeholder && (Boolean(it.cogsByHand) || (it.catalogCogs != null && it.cogs !== it.catalogCogs));
  // No ratio from the line's unit to the catalog's: the cost can't be checked,
  // so only a cost someone typed (which never came from the catalog) is kept.
  if (current === null) return typed ? it : { ...it, held: true };
  if (placeholder) return { ...it, cogs: current.cost, catalogCogs: current.cost, estCogs: false };
  if (typed) return it;
  if (it.catalogCogs != null) {
    return current.cost !== it.catalogCogs ? { ...it, cogs: current.cost, catalogCogs: current.cost } : it;
  }
  return Math.abs(it.cogs - current.cost) <= 0.5 * current.factor + 0.01
    ? { ...it, catalogCogs: it.cogs }
    : { ...it, held: true };
}

/** The catalog item's COGS in the unit this line is priced in, with that unit's ratio; null when none is known. */
function catalogCostIn(item: CatalogItem, line: QuoteItem): { cost: number; factor: number } | null {
  if (!(item.cogs > 0)) return null;
  const factor = unitFactor({ baseUom: item.uom || "Pcs", units: item.units ?? [] }, priceUnitOf(line));
  return factor === undefined ? null : { cost: Math.round(item.cogs * factor * 100) / 100, factor };
}

/** Codes whose catalog row applyHolds compares draft lines against: coded lines not already held. */
export const recostCodes = (quotes: { status: string; items: QuoteItem[] }[], problems: Map<string, string>) =>
  quotes
    .filter((q) => LIVE_HOLD_STATUSES.has(q.status))
    .flatMap((q) => q.items.filter((it) => it.code && !problems.has(it.code)).map((it) => it.code));

/** Codes on quotes whose holds follow the catalog, for one problem lookup over a list. */
export const liveHoldCodes = (quotes: { status: string; items: QuoteItem[] }[]) =>
  quotes.filter((q) => LIVE_HOLD_STATUSES.has(q.status)).flatMap((q) => q.items.map((it) => it.code));

export const ALL_HELD =
  "Semua item ditahan karena COGS-nya perlu dicek manajer, jadi belum ada yang bisa diajukan.";
