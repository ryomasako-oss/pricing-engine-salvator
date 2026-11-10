/* The catalog search index (shared/catalogSearch.ts), built once per Worker isolate from every
   catalog item and kept for a minute, so a search per keystroke reads D1 only for the page it shows.
   Also the priority categories (Pengaturan › Pencarian), default ARTLINE, V-TEC, GM Stationery. */

import { all, getSetting, run, setSetting } from "../db.d1";
import { buildSearchIndex, queryKey, queryWords, searchCatalog, type SearchIndex, type SearchResult } from "../../shared/catalogSearch";
import { SEMANTIC_BELOW, semanticCodes } from "./catalogSemantic";
import type { Bindings } from "./env";

export interface IndexedItem {
  code: string;
  name: string;
  category: string;
  stock: number;
  cogs: number;
  list_price: number;
  has_image: number;
  aliases: string[];
  popularity: number;
}

export const SEARCH_PRIORITY_KEY = "search_priority";
export const DEFAULT_SEARCH_PRIORITY = ["ARTLINE", "V-TEC", "GM Stationery"];

// shortcut: an edit shows in search after at most a minute (or at once in the isolate that made it);
// if that is ever too slow, key the cache on a catalog version bumped by every write.
const TTL_MS = 60_000;
// The build in flight is shared, so a burst of searches on a cold isolate reads the catalog once.
let cached: { db: D1Database; at: number; index: Promise<SearchIndex<IndexedItem>> } | null = null;

/** Drop the index so the next search rebuilds it (call after a catalog write in this isolate). */
export function forgetCatalogIndex(): void {
  cached = null;
}

export function catalogIndex(db: D1Database): Promise<SearchIndex<IndexedItem>> {
  if (cached && cached.db === db && Date.now() - cached.at < TTL_MS) return cached.index;
  const index = buildIndex(db);
  cached = { db, at: Date.now(), index };
  index.catch(() => cached?.index === index && (cached = null));
  return index;
}

async function buildIndex(db: D1Database): Promise<SearchIndex<IndexedItem>> {
  const rows = await all<Omit<IndexedItem, "aliases" | "popularity">>(
    db,
    `SELECT code, name, category, stock, cogs, list_price,
            EXISTS(SELECT 1 FROM item_images i WHERE i.code = c.code) AS has_image
       FROM catalog_items c`,
  );
  // What it learns from (catalogSearch.ts): wordings matched before, and how often each item appears on
  // sales invoices (SI) and purchase invoices (PI) of the last year and on quotations.
  const [aliases, sold, bought, quotes] = await Promise.all([
    all<{ code: string; alias: string }>(db, "SELECT code, alias FROM catalog_aliases"),
    all<{ code: string; n: number }>(
      db,
      "SELECT item_code AS code, COUNT(DISTINCT invoice_id) AS n FROM accurate_sales_lines WHERE trans_date >= date('now', '-365 day') GROUP BY item_code",
    ),
    all<{ code: string; n: number }>(
      db,
      "SELECT item_code AS code, COUNT(DISTINCT receipt_id) AS n FROM accurate_purchase_lines WHERE trans_date >= date('now', '-365 day') GROUP BY item_code",
    ).catch(() => []),
    // shortcut: reads every quote's items once a minute; fine for hundreds of quotes, a counts table past that.
    all<{ items: string }>(db, "SELECT items FROM quotes"),
  ]);
  const aliasOf = new Map<string, string[]>();
  for (const a of aliases) aliasOf.set(a.code, [...(aliasOf.get(a.code) ?? []), a.alias]);
  const pop = new Map<string, number>();
  const bump = (code: string, n: number) => code && pop.set(code, (pop.get(code) ?? 0) + n);
  for (const r of [...sold, ...bought]) bump(r.code, r.n);
  for (const q of quotes) {
    try {
      for (const it of JSON.parse(q.items) as { code?: string }[]) bump(String(it.code ?? "").trim(), 1);
    } catch {
      /* a quote with unreadable items adds nothing */
    }
  }
  const full: IndexedItem[] = rows.map((r) => ({ ...r, aliases: aliasOf.get(r.code) ?? [], popularity: pop.get(r.code) ?? 0 }));
  return buildSearchIndex(full);
}

export async function searchPriority(db: D1Database): Promise<string[]> {
  const v = await getSetting<unknown>(db, SEARCH_PRIORITY_KEY, DEFAULT_SEARCH_PRIORITY);
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : DEFAULT_SEARCH_PRIORITY;
}

export const saveSearchPriority = (db: D1Database, categories: string[]) => setSetting(db, SEARCH_PRIORITY_KEY, categories);

/** A pick counts half after this many days without being picked again. */
const PICK_HALF_LIFE_DAYS = 90;

/** Items picked before after these words, weighted so that an old habit fades. */
async function pickedFor(db: D1Database, q: string): Promise<Map<string, number>> {
  const key = queryKey(q);
  if (!key) return new Map();
  const rows = await all<{ code: string; picks: number; age: number }>(
    db,
    "SELECT code, picks, julianday('now') - julianday(last_at) AS age FROM search_picks WHERE query_key = ?",
    key,
  ).catch(() => []); // before migration 0034: no habit yet
  return new Map(rows.map((r) => [r.code, r.picks * 0.5 ** (Math.max(0, r.age) / PICK_HALF_LIFE_DAYS)]));
}

/** Remembers that these items were picked after typing `q` (CatalogPicker "Tambahkan"). */
export async function recordPicks(db: D1Database, q: string, codes: string[]): Promise<void> {
  const key = queryKey(q);
  if (!key) return;
  for (const code of new Set(codes)) {
    await run(
      db,
      `INSERT INTO search_picks(query_key, code, picks, last_at) VALUES(?, ?, 1, datetime('now'))
       ON CONFLICT(query_key, code) DO UPDATE SET picks = picks + 1, last_at = excluded.last_at`,
      key,
      code,
    );
  }
}

/** The whole catalog ranked for `q` (every item for an empty q, priority brands first). */
export async function searchItems(db: D1Database, q: string): Promise<SearchResult<IndexedItem>> {
  const [index, priority, picked] = await Promise.all([catalogIndex(db), searchPriority(db), pickedFor(db, q)]);
  return searchCatalog(index, q, { priority, picked });
}

/**
 * Word search, plus items close in meaning (catalogSemantic.ts) when the words find few items or not
 * every word. Word matches stay first; meaning matches follow (or lead, when no item had every word).
 */
export async function searchWithMeaning(
  env: Pick<Bindings, "DB" | "AI" | "CATALOG_VECTORS" | "CATALOG_SEMANTIC_SEARCH">,
  q: string,
): Promise<SearchResult<IndexedItem> & { byMeaning: number }> {
  const words = await searchItems(env.DB, q);
  const typed = queryWords(q);
  // Ask the AI only once the last word looks finished (3+ letters), not on every first keystroke.
  if (!typed.length || typed[typed.length - 1].length < 3 || (words.items.length >= SEMANTIC_BELOW && !words.partial)) {
    return { ...words, byMeaning: 0 };
  }
  const codes = await semanticCodes(env, q);
  if (!codes.length) return { ...words, byMeaning: 0 };
  const index = await catalogIndex(env.DB);
  const byCode = new Map(index.docs.map((d) => [d.code, d]));
  const seen = new Set(words.items.map((d) => d.code));
  const meant = codes.filter((c) => !seen.has(c)).map((c) => byCode.get(c)).filter((d): d is IndexedItem => !!d);
  const items = words.partial ? [...meant, ...words.items] : [...words.items, ...meant];
  return { ...words, items, byMeaning: meant.length };
}
