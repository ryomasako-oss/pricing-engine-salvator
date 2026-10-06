/* ============================================================
   Request/response shape for "build a quote from a client's list",
   shared by the Express and Worker catalog routes so the two backends
   only differ in how they load rows, never in what they decide.

   POST /api/catalog/match   — match request lines to catalog items
   POST /api/catalog/aliases — remember a rep's confirmed pairings
   ============================================================ */

import { z } from "zod";
import { normalizeCode } from "../shared/duplicates.js";
import { type AliasMaps, type MatchResult, matchLines, normalizeText } from "../shared/match.js";
import { hasPermission } from "../shared/permissions.js";
import type { CatalogItem, Role, UnitFactor } from "../shared/types.js";

export const MAX_MATCH_LINES = 500;

export const matchInput = z.object({
  client_id: z.number().int().positive().nullable().optional(),
  lines: z
    .array(
      z.object({
        code: z.string().max(64).optional(),
        name: z.string().trim().min(1).max(300),
        uom: z.string().max(32).optional(),
        qty: z.number().finite().nonnegative().optional(),
        rrp: z.number().finite().nonnegative().optional(),
      }),
    )
    .min(1)
    .max(MAX_MATCH_LINES),
});

export const aliasInput = z.object({
  client_id: z.number().int().positive().nullable().optional(),
  pairs: z
    .array(z.object({ text: z.string().trim().min(1).max(300), code: z.string().trim().min(1).max(64) }))
    .min(1)
    .max(MAX_MATCH_LINES),
});

/**
 * An alias with no client is stored for every client and matches as "exact",
 * skipping review, so only someone who may edit the catalog can save one.
 * A rep's confirmations are saved for the client they chose (the UI never
 * sends one without a client).
 */
export function mayStoreAlias(role: Role, clientId: number | null | undefined): boolean {
  return Boolean(clientId) || hasPermission(role, "edit_catalog");
}
export const GLOBAL_ALIAS_DENIED = "Istilah untuk semua klien hanya bisa disimpan manajer. Pilih klien dulu.";

/** Columns the matcher and the review screen need; loaded for the whole catalog. */
export const MATCH_COLUMNS = "id, code, name, uom, cogs, list_price, stock, category";

export interface AliasRow {
  alias: string;
  client_id: number;
  code: string;
}

export function aliasMaps(rows: AliasRow[], clientId: number | null | undefined): AliasMaps {
  const maps: AliasMaps = { client: new Map(), global: new Map() };
  for (const r of rows) {
    if (r.client_id === 0) maps.global.set(r.alias, r.code);
    else if (clientId && r.client_id === clientId) maps.client.set(r.alias, r.code);
  }
  return maps;
}

export function runMatch(
  input: z.infer<typeof matchInput>,
  catalog: CatalogItem[],
  aliases: AliasRow[],
): { results: MatchResult[]; referenced: CatalogItem[] } {
  const results = matchLines(input.lines, catalog, aliasMaps(aliases, input.client_id));
  const ids = new Set(results.flatMap((r) => r.candidates.map((c) => c.id)));
  return { results, referenced: catalog.filter((it) => ids.has(it.id)) };
}

/** The response body, once units for the referenced items are loaded. */
export function matchResponse(
  results: MatchResult[],
  referenced: CatalogItem[],
  units: Map<string, UnitFactor[]>,
) {
  const summary = { exact: 0, match: 0, review: 0, none: 0 };
  for (const r of results) summary[r.status]++;
  return {
    results,
    items: referenced.map((it) => ({ ...it, units: units.get(it.code) ?? [] })),
    summary,
  };
}

/**
 * Pairs to store: normalised text, de-duplicated (last one wins), codes resolved
 * to the catalog's own spelling. Returns the codes that aren't in the catalog
 * so the route can reject the request instead of storing a dangling alias.
 */
export function cleanAliasPairs(
  pairs: z.infer<typeof aliasInput>["pairs"],
  catalogCodes: string[],
): { pairs: { alias: string; code: string }[]; unknown: string[] } {
  const known = new Map(catalogCodes.map((c) => [normalizeCode(c), c]));
  const out = new Map<string, string>();
  const unknown: string[] = [];
  for (const p of pairs) {
    const code = known.get(normalizeCode(p.code));
    if (!code) {
      unknown.push(p.code);
      continue;
    }
    const alias = normalizeText(p.text);
    if (alias) out.set(alias, code);
  }
  return { pairs: [...out].map(([alias, code]) => ({ alias, code })), unknown };
}
