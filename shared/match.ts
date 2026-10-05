/* ============================================================
   Matching a client's request list against the catalog.

   A client sends "Kertas A4 Sinar Dunia 70gsm — 50 rim"; the catalog has
   "KERTAS HVS SIDU A4 70GR". Each requested line is matched in this order:

   1. Code: the request carries a catalog code (case/space-insensitive).
   2. Alias: a sales rep confirmed this exact wording earlier. A mapping
      saved for the quote's client wins over a global one, because one
      client's "pulpen hitam" can be a different pen from another's.
   3. Name similarity: weighted token overlap. Tokens with digits (A4, 70g,
      0.5mm) weigh more, and a size the request names but the candidate
      lacks is penalised — 70g and 80g paper are different products.

   Codes and aliases are "exact". A similarity match is only "match" when it
   is strong, clearly ahead of the runner-up, and the item name contains
   every word the client wrote; otherwise "review", and the rep picks. Prices are never part of matching: COGS and RRP always
   come from the catalog row the server loaded.

   Pure: no I/O, so both backends and the client share one implementation.
   ============================================================ */

import { normalizeCode } from "./duplicates.js";
import type { CatalogItem, QuoteItem } from "./types.js";
import { changeLineUom, sameUom } from "./uom.js";

export interface RequestLine {
  code?: string;
  name: string;
  uom?: string;
  qty?: number;
  /** Ceiling price the client stated, if their list had one. */
  rrp?: number;
  /**
   * The client gave no quantity (meeting 2026-10-05, point 9b): the line is
   * quoted as 1 of the item's lowest (base) unit, whatever unit they wrote.
   */
  noQty?: boolean;
}

export type MatchStatus = "exact" | "match" | "review" | "none";

export interface Candidate {
  id: number;
  score: number;
}

export interface MatchResult {
  index: number;
  status: MatchStatus;
  via: "code" | "alias" | "name" | null;
  /** Best candidate first; at most MAX_ALTERNATIVES. Empty when nothing scored. */
  candidates: Candidate[];
}

/** Alias text (normalised with `normalizeText`) -> catalog code. */
export interface AliasMaps {
  client: Map<string, string>;
  global: Map<string, string>;
}

export type MatchableItem = Pick<CatalogItem, "id" | "code" | "name">;

export const MATCH_SCORE = 0.8;
export const REVIEW_SCORE = 0.45;
/** A "match" must beat the runner-up by this much, or it is a coin toss. */
export const MATCH_MARGIN = 0.08;
export const MAX_ALTERNATIVES = 5;

const SYNONYMS: Record<string, string> = {
  pena: "pulpen",
  pen: "pulpen",
  bolpen: "pulpen",
  ballpoint: "pulpen",
  bolpoin: "pulpen",
  ballpen: "pulpen",
  marker: "spidol",
  folder: "map",
  paper: "kertas",
  black: "hitam",
  blue: "biru",
  red: "merah",
  green: "hijau",
  yellow: "kuning",
  white: "putih",
  lembar: "lbr",
  sheet: "lbr",
  sheets: "lbr",
};

/** Words that say nothing about which product is meant. */
const STOP = new Set(["dan", "untuk", "isi", "merk", "merek", "warna", "ukuran", "uk", "type", "tipe", "jenis", "per", "the", "x"]);

/** Lowercase, unify units glued to numbers ("70 gsm" -> "70g"), strip punctuation. */
export function normalizeText(s: string): string {
  return (s ?? "")
    .toLowerCase()
    .replace(/(\d)\s*(gsm|gram|grm|gr|g)\b/g, "$1g")
    .replace(/(\d)\s*(mm|cm|ml|ltr|lt|l|kg|m)\b/g, "$1$2")
    .replace(/(\d),(\d)/g, "$1.$2")
    // A dot survives only as a decimal point (0.5mm); "No.10" -> "no 10".
    .replace(/(?<!\d)\.|\.(?!\d)/g, " ")
    .replace(/[^a-z0-9.]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function tokens(s: string): string[] {
  const out: string[] = [];
  for (const raw of normalizeText(s).split(" ")) {
    if (!raw || STOP.has(raw)) continue;
    out.push(SYNONYMS[raw] ?? raw);
  }
  return [...new Set(out)];
}

const hasDigit = (t: string) => /\d/.test(t);
const weight = (t: string) => (hasDigit(t) ? 2 : 1);

/** Equal, or a word of 4+ letters plus at most 2 more ("map"/"maps" no, "kertas"/"kertasnya" no, "spidol"/"spidols" yes). Never fuzzy on sizes. */
function tokenHit(a: string, b: string): boolean {
  if (a === b) return true;
  if (hasDigit(a) || hasDigit(b)) return false;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 4 && long.startsWith(short) && long.length - short.length <= 2;
}

/**
 * Similarity in [0, 1] between a request and a catalog name. Mostly "how much
 * of what the client asked for does this item cover", with a smaller share for
 * how specific the item name is overall, so a short exact name beats a long one.
 */
export function similarity(requestTokens: string[], itemTokens: string[]): number {
  return compare(requestTokens, itemTokens).score;
}

/** Score plus whether every requested token was found in the item name. */
function compare(requestTokens: string[], itemTokens: string[]): { score: number; complete: boolean } {
  if (!requestTokens.length || !itemTokens.length) return { score: 0, complete: false };
  let hitWeight = 0;
  let reqWeight = 0;
  let missingSize = false;
  for (const t of requestTokens) {
    reqWeight += weight(t);
    if (itemTokens.some((u) => tokenHit(t, u))) hitWeight += weight(t);
    else if (hasDigit(t)) missingSize = true;
  }
  let itemWeight = 0;
  let itemHit = 0;
  for (const u of itemTokens) {
    itemWeight += weight(u);
    if (requestTokens.some((t) => tokenHit(t, u))) itemHit += weight(u);
  }
  const coverage = hitWeight / reqWeight;
  const precision = itemHit / itemWeight;
  const score = 0.75 * coverage + 0.25 * precision;
  return { score: missingSize ? score * 0.6 : score, complete: hitWeight === reqWeight };
}

/**
 * Precomputed tokens per catalog item, plus an inverted index so a line is
 * scored only against items it shares a token with. An item sharing nothing
 * scores 0 anyway (`tokenHit` needs an equal token, or two words with the same
 * first 4 letters), so this changes speed, not results: 500 lines against the
 * ~6,800-item catalog went from ~7.6 s to well under a second.
 */
export interface CatalogIndex<T extends MatchableItem = MatchableItem> {
  items: T[];
  byCode: Map<string, T>;
  tokens: string[][];
  byToken: Map<string, number[]>;
  /** First 4 letters of each digit-free word of 4+ letters -> item positions. */
  byPrefix: Map<string, number[]>;
}

const prefixKey = (t: string) => (t.length >= 4 && !hasDigit(t) ? t.slice(0, 4) : null);

function push(map: Map<string, number[]>, key: string, i: number) {
  const list = map.get(key);
  if (!list) map.set(key, [i]);
  else if (list[list.length - 1] !== i) list.push(i);
}

export function buildIndex<T extends MatchableItem>(items: T[]): CatalogIndex<T> {
  const byCode = new Map<string, T>();
  for (const it of items) {
    const key = normalizeCode(it.code);
    if (key && !byCode.has(key)) byCode.set(key, it);
  }
  const tokenLists = items.map((it) => tokens(it.name));
  const byToken = new Map<string, number[]>();
  const byPrefix = new Map<string, number[]>();
  tokenLists.forEach((list, i) => {
    for (const t of list) {
      push(byToken, t, i);
      const p = prefixKey(t);
      if (p) push(byPrefix, p, i);
    }
  });
  return { items, byCode, tokens: tokenLists, byToken, byPrefix };
}

/** Positions of items that share at least one token (or 4-letter word prefix) with the request. */
function candidatesFor(req: string[], catalog: CatalogIndex): Set<number> {
  const out = new Set<number>();
  for (const t of req) {
    for (const i of catalog.byToken.get(t) ?? []) out.add(i);
    const p = prefixKey(t);
    if (p) for (const i of catalog.byPrefix.get(p) ?? []) out.add(i);
  }
  return out;
}

export function matchLine<T extends MatchableItem>(
  line: RequestLine,
  index: number,
  catalog: CatalogIndex<T>,
  aliases: AliasMaps = { client: new Map(), global: new Map() },
): MatchResult {
  const code = normalizeCode(line.code);
  const byCode = code ? catalog.byCode.get(code) : undefined;
  if (byCode) return { index, status: "exact", via: "code", candidates: [{ id: byCode.id, score: 1 }] };

  const text = normalizeText(line.name);
  const aliased = aliases.client.get(text) ?? aliases.global.get(text);
  const byAlias = aliased ? catalog.byCode.get(normalizeCode(aliased)) : undefined;

  const req = tokens(line.name);
  const scored: Candidate[] = [];
  const posOf = new Map<number, number>();
  for (const i of candidatesFor(req, catalog)) {
    const score = similarity(req, catalog.tokens[i]);
    if (score < REVIEW_SCORE / 2) continue;
    scored.push({ id: catalog.items[i].id, score: Math.round(score * 1000) / 1000 });
    posOf.set(catalog.items[i].id, i);
  }
  scored.sort((a, b) => b.score - a.score || a.id - b.id);

  if (byAlias) {
    const rest = scored.filter((c) => c.id !== byAlias.id).slice(0, MAX_ALTERNATIVES - 1);
    return { index, status: "exact", via: "alias", candidates: [{ id: byAlias.id, score: 1 }, ...rest] };
  }

  const top = scored.slice(0, MAX_ALTERNATIVES);
  const best = top[0];
  if (!best || best.score < REVIEW_SCORE) return { index, status: "none", via: null, candidates: top };
  const runnerUp = top[1]?.score ?? 0;
  // A word the client wrote that the item lacks ("Sinar Dunia" vs "BOLA DUNIA")
  // may be the brand. Never auto-accept that, however high the score.
  const bestTokens = catalog.tokens[posOf.get(best.id)!];
  const complete = compare(req, bestTokens).complete;
  const status: MatchStatus =
    complete && best.score >= MATCH_SCORE && best.score - runnerUp >= MATCH_MARGIN ? "match" : "review";
  return { index, status, via: "name", candidates: top };
}

export function matchLines<T extends MatchableItem>(
  lines: RequestLine[],
  catalog: T[],
  aliases?: AliasMaps,
): MatchResult[] {
  const idx = buildIndex(catalog);
  return lines.map((line, i) => matchLine(line, i, idx, aliases));
}

/**
 * The quote line for a catalog item: built in the item's base unit with the
 * catalog's COGS and list price, then converted to the requested unit with
 * the item's ratio (so "2 Box" is priced per Box, not per Pcs). A ceiling the
 * client stated is per the *requested* unit, so it is applied after conversion.
 */
export function lineFromCatalog(
  item: CatalogItem,
  qty: number,
  opts: { uom?: string; rrp?: number } = {},
): QuoteItem {
  const baseUom = item.uom || "Pcs";
  const base: QuoteItem = {
    id: `cat-${item.id}-${Math.random().toString(36).slice(2, 7)}`,
    lineNo: 0,
    code: item.code,
    name: item.name,
    uom: baseUom,
    qty,
    cogs: Math.round(item.cogs),
    // The master's list price is the natural starting ceiling.
    rrp: Math.round(item.list_price || item.cogs * 1.4),
    role: "CORE",
    estCogs: !(item.cogs > 0),
  };
  // Use the catalog's spelling of a known unit ("box" -> "Box"), so the line's
  // unit dropdown recognises it.
  const asked = opts.uom?.trim();
  const to = asked && (item.units ?? []).find((u) => sameUom(u.uom, asked))?.uom || asked;
  const line = to && !sameUom(to, baseUom) ? changeLineUom(base, to, { baseUom, units: item.units ?? [] }) : base;
  return opts.rrp && opts.rrp > 0 ? { ...line, rrp: Math.round(opts.rrp) } : line;
}
