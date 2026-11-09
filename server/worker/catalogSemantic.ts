/* Lapis 2 pencarian barang: makna, bukan hanya kata (Ryoma, 2026-11-09: "search engine dengan model AI").
   "lem kertas" finds GLUE STICK, "alat tulis papan tulis" finds WHITEBOARD MARKER, where no word matches.

   Each catalog item ("name category") is turned once into an embedding by Workers AI (bge-m3, multilingual)
   and kept in a Vectorize index under its code. A search embeds only the typed text and asks for the
   nearest items. It only adds to the word search (catalogSearchIndex.ts), which stays first and instant:
   the AI is asked when words find few items or not every word, never per item.

   Off unless all three are set (README "Pencarian barang"): bindings AI and CATALOG_VECTORS, and
   CATALOG_SEMANTIC_SEARCH = "true". Any AI failure falls back to the word search alone. */

import { all, get, getSetting, setSetting } from "../db.d1";
import type { Bindings } from "./env";

export const EMBED_MODEL = "@cf/baai/bge-m3";
/** Fewer word matches than this, or not every word matched: ask the AI too. */
export const SEMANTIC_BELOW = 20;
const TOP_K = 40;
// shortcut: a fixed cosine floor for bge-m3, picked by eye; tune it on real queries once the index exists.
const MIN_SCORE = 0.55;
const BATCH = 50;

type Env = Pick<Bindings, "AI" | "CATALOG_VECTORS" | "CATALOG_SEMANTIC_SEARCH" | "DB">;

export const semanticEnabled = (env: Env) => !!env.AI && !!env.CATALOG_VECTORS && env.CATALOG_SEMANTIC_SEARCH === "true";

const docText = (r: { name: string; category: string }) => `${r.name} ${r.category ?? ""}`.trim();

async function embed(env: Env, text: string[]): Promise<number[][]> {
  const r = (await env.AI!.run(EMBED_MODEL, { text })) as { data?: number[][] };
  if (!r.data || r.data.length !== text.length) throw new Error("embedding kosong");
  return r.data;
}

/** Item codes nearest in meaning to `q`, best first; [] when off or on any failure. */
export async function semanticCodes(env: Env, q: string): Promise<string[]> {
  if (!semanticEnabled(env) || !q.trim()) return [];
  try {
    const [vector] = await embed(env, [q.trim()]);
    const r = await env.CATALOG_VECTORS!.query(vector, { topK: TOP_K });
    return r.matches.filter((m) => m.score >= MIN_SCORE).map((m) => m.id);
  } catch (e) {
    console.error("[search] semantic search failed:", e);
    return [];
  }
}

/**
 * Embeds `limit` catalog items from `offset` (by code) into the Vectorize index. Called page by page
 * (POST /api/catalog/search-index) so one request stays short; run again after a big catalog import.
 */
export async function indexCatalogPage(env: Env, offset: number, limit: number): Promise<{ indexed: number; next: number | null }> {
  if (!env.AI || !env.CATALOG_VECTORS) throw new Error("Binding AI dan CATALOG_VECTORS belum dipasang.");
  const rows = await all<{ code: string; name: string; category: string }>(
    env.DB,
    "SELECT code, name, category FROM catalog_items ORDER BY code LIMIT ? OFFSET ?",
    limit,
    offset,
  );
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const vectors = await embed(env, chunk.map(docText));
    await env.CATALOG_VECTORS.upsert(chunk.map((r, k) => ({ id: r.code, values: vectors[k] })));
  }
  return { indexed: rows.length, next: rows.length < limit ? null : offset + rows.length };
}

const STATE_KEY = "catalog_vectors_state";
/** Pages of 500 items per cron tick: 3 = ~30 AI calls, the whole catalog in about 25 minutes. */
const PAGES_PER_TICK = 3;

/**
 * Cron (every 5 minutes): fills the Vectorize index page by page, then refills it whenever an item is
 * added, removed or renamed (the catalog's count and name/category length change). Stock and price
 * changes don't touch it: they don't change what an item is.
 */
export async function vectorTick(env: Env): Promise<{ outcome: "idle" | "indexed"; offset: number | null }> {
  if (!semanticEnabled(env)) return { outcome: "idle", offset: null };
  // shortcut: a length sum misses a rename to an equally long name; a per-item text hash if that matters.
  const stamp = (await get<{ s: string }>(env.DB, "SELECT COUNT(*) || '|' || COALESCE(SUM(length(name) + length(category)), 0) AS s FROM catalog_items"))?.s ?? "";
  const state = await getSetting<{ offset: number | null; stamp: string }>(env.DB, STATE_KEY, { offset: 0, stamp: "" });
  let offset = state.offset === null ? (state.stamp === stamp ? null : 0) : state.offset;
  if (offset === null) return { outcome: "idle", offset: null };
  for (let k = 0; k < PAGES_PER_TICK && offset !== null; k++) offset = (await indexCatalogPage(env, offset, 500)).next;
  await setSetting(env.DB, STATE_KEY, { offset, stamp });
  return { outcome: "indexed", offset };
}
