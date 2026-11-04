/* ============================================================
   Matching a client's request list against the catalog.

   A client sends "Kertas A4 Sinar Dunia 70gsm — 50 rim"; the catalog has
   "KERTAS HVS SIDU A4 70GR". Each requested line is matched in this order:

   1. Code: the request carries a catalog code (case/space-insensitive) and
      its name agrees with that item (CODE_NAME_AGREES), or names nothing
      but the code. A client's own item codes share our 6-digit range: CGV's
      100591 "CAFE_GARAM 1 KG" is our 100591 DOWSIL sealant (2026-10-17, 71
      of 104 lines of their list were "exact" to the wrong item). A code
      whose name disagrees is ignored and the line is matched by name.
   2. Alias: a sales rep confirmed this exact wording earlier. A mapping
      saved for the quote's client wins over a global one, because one
      client's "pulpen hitam" can be a different pen from another's.
   3. Name similarity: weighted token overlap. Tokens with digits (A4, 70g,
      0.5mm) weigh more, and a size the request names but the candidate
      lacks is penalised — 70g and 80g paper are different products.

   Two things about the client's wording are read before scoring. Packaging in brackets
   ("(1 Gross @12 Pack)", "(isi 12/Lusin)") says how it is sold, not which product. Its
   words are optional: they help an item that has them ("(isi 10 ktk)" tells two Trigonal
   Clip rows apart) but never count against one that does not (a PO's binder clips all fell
   to "none" because "1", "6", "12" were read as sizes the item lacks).
   And a part number the client printed ("CT-522") that appears inside a catalog name lifts
   that item to at least PART_HINT_SCORE: never an auto "match", always a rep's call.

   A width in inches ("3\"", "2 inch", "3/4\"") is read as both the inch number and its usual
   millimetre size (3" = 72 mm), so a PO's `Lakban 3"` finds the catalog's "72MM". A fraction
   such as 3/4" is one token, so its "3" no longer matches a 3".

   Codes and aliases are "exact". A similarity match is only "match" when it
   is strong, clearly ahead of the runner-up, and the item name contains
   every word the client wrote; otherwise "review", and the rep picks. Prices are never part of matching: COGS and RRP always
   come from the catalog row the server loaded.

   Pure: no I/O, so both backends and the client share one implementation.
   ============================================================ */

import { normalizeCode } from "./duplicates.js";
import type { CatalogItem, QuoteItem } from "./types.js";
import { REJECTED_PENALTY, isRejectedPair, type Rejected } from "./matchLearning.js";
import { changeLineUom, readPackUnit, sameUom } from "./uom.js";

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
/** A part number the client printed that also appears in the item's name: strong, but only ever "review". */
export const PART_HINT_SCORE = 0.7;
/**
 * A code match also needs the line's name to look like the item. CGV's colliding codes scored
 * at most 0.24 against the item they hit; a genuine code with a two-word name scores 0.78+.
 */
export const CODE_NAME_AGREES = REVIEW_SCORE;

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
  bantalan: "pad",
  stempel: "stamp",
  lembar: "lbr",
  sheet: "lbr",
  sheets: "lbr",
};

/** Words that say nothing about which product is meant. */
// "atk" (alat tulis kantor) is a category a client prefixes to every line ("ATK_LAKBAN ..."), never part
// of an item name; as a word the item "lacks" it blocked every auto-match.
const STOP = new Set(["dan", "untuk", "isi", "merk", "merek", "warna", "ukuran", "uk", "type", "tipe", "jenis", "per", "the", "x", "atk"]);

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

/** Words that mark a bracket as packaging ("1 box @6 PCS", "isi 12/Lusin") or a loose dimension ("15.8 cm x 10.4 cm") rather than a product detail. */
const PACK_WORD = /\b(isi|box|pack|gross|lusin|kotak|dus|pcs|pak|ktk|lsn|karton)\b|@\s*\d|\d\s*(?:cm|mm)?\s*x\s*\d/i;

/** The client's wording split into the product part and the packaging brackets. "(Blue)", "(Besar)" and "(Tipe X Set)" stay in the product part. */
export function splitPackText(s: string): { core: string; pack: string } {
  const pack: string[] = [];
  const core = (s ?? "").replace(/\([^()]*\)/g, (group) => {
    if (!PACK_WORD.test(group)) return group;
    pack.push(group);
    return " ";
  });
  return { core, pack: pack.join(" ") };
}

/** Pattern for a part number like "CT-522" inside a catalog name, ignoring case and separators ("ct 522", "CT-522"). */
function partPattern(code: string | undefined): RegExp | null {
  const c = (code ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (c.length < 4 || !/[a-z]/.test(c) || !/\d/.test(c)) return null;
  return new RegExp(`(^|[^a-z0-9])${[...c].join("[^a-z0-9]*")}(?![0-9])`);
}

/** Tape and similar widths: inches as written -> millimetres as the catalog writes them. */
const INCH_MM: Record<string, number> = { "1f2": 12, "3f4": 19, "1": 24, "1p5": 36, "2": 48, "3": 72, "4": 96 };

/** Replace an inch mark ("3\"", "2 inch", "3/4\"") with a placeholder word that survives normalizeText. */
function markInches(s: string): string {
  const unit = `(?:"|”|''|inch|inci)`;
  return (s ?? "")
    .replace(new RegExp(`(\\d+)\\s*/\\s*(\\d+)\\s*${unit}`, "gi"), (_m, a, b) => ` zinch${a}f${b} `)
    .replace(new RegExp(`(\\d+(?:[.,]\\d+)?)\\s*${unit}`, "gi"), (_m, n) => ` zinch${String(n).replace(/[.,]/, "p")} `);
}

/** The placeholder back to a token: the inch number, plus " | " its millimetre size when it has a usual one. */
function unmarkInch(t: string): string {
  const m = /^zinch(\d+(?:[fp]\d+)?)$/.exec(t);
  if (!m) return t;
  const mm = INCH_MM[m[1]];
  const plain = m[1].replace("p", ".").replace("f", "/");
  return mm ? `${plain}|${mm}mm` : plain;
}

export function tokens(s: string): string[] {
  const out: string[] = [];
  for (const raw of normalizeText(markInches(s)).split(" ")) {
    if (!raw || STOP.has(raw)) continue;
    out.push(unmarkInch(SYNONYMS[raw] ?? raw));
  }
  return [...new Set(out)];
}

const hasDigit = (t: string) => /\d/.test(t);
const weight = (t: string) => (hasDigit(t) ? 2 : 1);

/** Equal, or a word of 4+ letters plus at most 2 more ("map"/"maps" no, "kertas"/"kertasnya" no, "spidol"/"spidols" yes). Never fuzzy on sizes. */
function tokenHit(a: string, b: string): boolean {
  if (a === b) return true;
  // An inch width carries its millimetre size as an alternative ("3|72mm"): either one is a hit.
  if (a.includes("|") || b.includes("|")) {
    const bs = b.split("|");
    return a.split("|").some((x) => bs.includes(x));
  }
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
      for (const part of t.split("|")) push(byToken, part, i);
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
    for (const part of t.split("|")) for (const i of catalog.byToken.get(part) ?? []) out.add(i);
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
  /** Pairings a rep already replaced (shared/matchLearning.ts); their score is cut. */
  rejected?: Rejected,
): MatchResult {
  const code = normalizeCode(line.code);
  const byCode = code ? catalog.byCode.get(code) : undefined;
  const { core, pack } = splitPackText(line.name);
  const req = tokens(core);
  const soft = tokens(pack).filter((t) => !req.includes(t));
  // Packaging words count only for the items that have them; an item with none of them loses a hair
  // (2%) so that, between two otherwise equal rows, the one that states the pack wins.
  const packHits = (i: number) => soft.filter((t) => catalog.tokens[i].some((u) => tokenHit(t, u)));
  const wording = (i: number) => (soft.length ? [...req, ...packHits(i)] : req);
  const packFactor = (i: number) => (soft.length && !packHits(i).length ? 0.98 : 1);
  if (byCode) {
    // A line that names nothing but its code (or nothing at all) has nothing to disagree with.
    const nameIsCode = !req.length || normalizeCode(line.name) === code;
    if (nameIsCode || similarity(req, tokens(byCode.name)) >= CODE_NAME_AGREES) {
      return { index, status: "exact", via: "code", candidates: [{ id: byCode.id, score: 1 }] };
    }
  }

  const text = normalizeText(line.name);
  const aliased = aliases.client.get(text) ?? aliases.global.get(text);
  const byAlias = aliased ? catalog.byCode.get(normalizeCode(aliased)) : undefined;

  const part = byCode ? null : partPattern(line.code);
  const scored: Candidate[] = [];
  const posOf = new Map<number, number>();
  for (const i of candidatesFor(req, catalog)) {
    const raw = similarity(wording(i), catalog.tokens[i]) * packFactor(i);
    if (raw < REVIEW_SCORE / 2) continue;
    // A pairing this wording was already corrected away from never scores as a
    // certainty again, but stays on the list: one correction can be the mistake.
    let score = isRejectedPair(rejected, text, catalog.items[i].code) ? raw * REJECTED_PENALTY : raw;
    if (part && score < PART_HINT_SCORE && part.test(catalog.items[i].name.toLowerCase())) score = PART_HINT_SCORE;
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
  const complete = compare(wording(posOf.get(best.id)!), bestTokens).complete;
  const status: MatchStatus =
    complete && best.score >= MATCH_SCORE && best.score - runnerUp >= MATCH_MARGIN ? "match" : "review";
  return { index, status, via: "name", candidates: top };
}

export function matchLines<T extends MatchableItem>(
  lines: RequestLine[],
  catalog: T[],
  aliases?: AliasMaps,
  rejected?: Rejected,
): MatchResult[] {
  const idx = buildIndex(catalog);
  return lines.map((line, i) => matchLine(line, i, idx, aliases, rejected));
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
  opts: { uom?: string; rrp?: number; /** The client's wording, read for a pack unit ("isi 12/Lusin") when they gave no unit. */ requestName?: string } = {},
): QuoteItem {
  const baseUom = item.uom || "Pcs";
  const base: QuoteItem = {
    id: `cat-${item.id}-${Math.random().toString(36).slice(2, 7)}`,
    lineNo: 0,
    code: item.code,
    name: item.name,
    uom: baseUom,
    qty,
    // Staff receive catalog rows without COGS (PE-1), and an item may have no
    // list price: a missing number is 0, never NaN (which reaches the server
    // as null and fails validation).
    cogs: Math.round(Number(item.cogs) || 0),
    // The price the client last paid (a sales invoice), else the master's list price.
    rrp: Math.round(Number(item.last_sale?.price) || Number(item.list_price) || (Number(item.cogs) || 0) * 1.4),
    role: "CORE",
    estCogs: !(item.cogs > 0),
    // Where the cost came from, so a draft can follow a corrected catalog (server/cogsCheck.ts).
    ...(item.cogs > 0 ? { catalogCogs: Math.round(Number(item.cogs)) } : {}),
  };
  // Use the catalog's spelling of a known unit ("box" -> "Box"), so the line's
  // unit dropdown recognises it.
  const asked = opts.uom?.trim() || (opts.requestName ? readPackUnit(opts.requestName, item).uom : undefined);
  const to = asked && (item.units ?? []).find((u) => sameUom(u.uom, asked))?.uom || asked;
  const line = to && !sameUom(to, baseUom) ? changeLineUom(base, to, { baseUom, units: item.units ?? [] }) : base;
  return opts.rrp && opts.rrp > 0 ? { ...line, rrp: Math.round(opts.rrp) } : line;
}
