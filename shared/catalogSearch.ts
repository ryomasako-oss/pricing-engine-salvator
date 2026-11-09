/* Pencarian barang ala mesin cari (Ryoma, 2026-11-09): hasil muncul saat mengetik, kata bebas
   urutan, tahan salah ketik dengan saran ejaan, merek prioritas di atas, daftar panjang.

   Pure and in memory: the Worker builds one index of the whole catalog (server/worker/catalogSearchIndex.ts)
   and every catalog search (quotation picker, Katalog, Silvy) ranks through it.

   - Every typed word must match the item (name, code or category), in any order.
   - A word matches a catalog word when equal, when it starts it (the word being typed), when it sits
     inside it (3+ letters), through a synonym (shared/searchSynonyms.ts), or within 1-2 typos.
   - Words with digits ("0.5", "a4", "70g") never match by typo: a size is a size.
   - Items of the priority categories (Pengaturan, default ARTLINE, V-TEC, GM Stationery) come first
     among equally good matches; nothing else is dropped.
   - When no item has every word, the items missing one word are shown, marked partial.
   - A word found only by typo gets a suggestion: "artlin" → "Mungkin maksud Anda: artline".
   - It learns (Ryoma, 2026-11-09 "belajar dari kebiasaan"): how a client wrote an item before
     (Pencocokan aliases) is searchable; an item picked after typing these words comes first next time
     (`picked`); items that often appear on sales invoices (SI), purchase invoices (PI) and quotations
     rise among equally good matches (`popularity`). Habit only reorders matches, it never brings in an
     item the words don't find. */

import { normalizeText } from "./match.js";
import { splitBrandQuery } from "./priorityBrands.js";
import { synonymsOf } from "./searchSynonyms.js";

export interface SearchDoc {
  code: string;
  name: string;
  category: string;
  /** Wordings learned for this item (Pencocokan aliases), searchable like its name. */
  aliases?: string[];
  /** How often it appears on SI, PI and quotations (any scale; only the order matters). */
  popularity?: number;
}

export interface SearchIndex<T extends SearchDoc = SearchDoc> {
  docs: T[];
  /** Per doc: its words (name, category, code), plus adjacent pairs joined ("v tec" → "vtec"). */
  words: string[][];
  /** Every catalog word and how many items use it, for typo matching and suggestions. */
  vocab: Map<string, number>;
  /** Normalised category and name per doc, for the priority order. */
  category: string[];
  name: string[];
}

export interface SearchResult<T extends SearchDoc = SearchDoc> {
  items: T[];
  /** No item had every word; these miss one. */
  partial: boolean;
  /** The query with typos corrected, when a word was found only by a typo. */
  suggestion: string | null;
}

const norm = (s: string) => normalizeText(s ?? "");
const compact = (s: string) => (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const hasDigit = (w: string) => /\d/.test(w);

function docWords(d: SearchDoc): string[] {
  const name = norm(d.name).split(" ").filter(Boolean);
  const out = new Set(name);
  for (let i = 0; i + 1 < name.length; i++) out.add(name[i] + name[i + 1]);
  for (const w of norm(d.category).split(" ")) if (w) out.add(w);
  if (compact(d.category)) out.add(compact(d.category));
  const code = compact(d.code);
  if (code) out.add(code);
  for (const w of norm(d.code).split(" ")) if (w) out.add(w);
  for (const a of d.aliases ?? []) for (const w of norm(a).split(" ")) if (w) out.add(w);
  return [...out];
}

export function buildSearchIndex<T extends SearchDoc>(docs: T[]): SearchIndex<T> {
  const words = docs.map(docWords);
  const vocab = new Map<string, number>();
  for (const ws of words) for (const w of ws) vocab.set(w, (vocab.get(w) ?? 0) + 1);
  return { docs, words, vocab, category: docs.map((d) => norm(d.category)), name: docs.map((d) => norm(d.name)) };
}

/** Optimal string alignment distance (Damerau: a swap of two letters is one typo), capped at max+1. */
export function typoDistance(a: string, b: string, max = 2): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const prev2 = new Array(b.length + 1).fill(0);
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur.push(v);
      rowMin = Math.min(rowMin, v);
    }
    if (rowMin > max) return max + 1;
    prev2.splice(0, prev2.length, ...prev);
    prev = cur;
  }
  return prev[b.length];
}

/** Typos allowed for a typed word: none under 4 letters or with digits, 1 up to 6 letters, 2 above. */
const typoBudget = (w: string) => (hasDigit(w) || w.length < 4 ? 0 : w.length <= 6 ? 1 : 2);

const EXACT = 1;
const PREFIX = 0.85;
const SYNONYM = 0.8;
const INSIDE = 0.6;
const TYPO = 0.45;

/** How well each catalog word matches one typed word (0 = not at all), and whether only typos match. */
function wordScores(vocab: Map<string, number>, typed: string, isLast: boolean): { scores: Map<string, number>; typoOnly: boolean; best: string | null } {
  const scores = new Map<string, number>();
  const syn = new Set(synonymsOf(typed).map(compact));
  // A 1-2 letter word only matches as the start of a word while it is still being typed, or exactly.
  const prefixOk = isLast || typed.length >= 2;
  const budget = typoBudget(typed);
  let direct = false;
  let best: string | null = null;
  let bestKey = [Infinity, 0];
  for (const [w, freq] of vocab) {
    let s = 0;
    if (w === typed) s = EXACT;
    else if (prefixOk && w.startsWith(typed)) s = PREFIX;
    else if (syn.has(w)) s = SYNONYM;
    else if (typed.length >= 3 && w.includes(typed)) s = INSIDE;
    if (s > 0) direct = true;
    else if (budget && !hasDigit(w) && w[0] === typed[0]) {
      const d = typoDistance(typed, w, budget);
      if (d <= budget) {
        s = TYPO;
        if (d < bestKey[0] || (d === bestKey[0] && freq > bestKey[1])) (best = w), (bestKey = [d, freq]);
      }
    }
    if (s > 0) scores.set(w, s);
  }
  return { scores, typoOnly: !direct && scores.size > 0, best };
}

/** The same words in any order give the same key: what a pick is remembered under. */
export const queryKey = (q: string) => [...queryWords(q)].sort().join(" ");

/**
 * Typed words: normalised like catalog names; a word repeated counts once. A priority brand in any
 * spelling ("vitek", "art line", "G.M") becomes the catalog's own word (shared/priorityBrands.ts).
 */
export function queryWords(q: string): string[] {
  const { catalog, rest } = splitBrandQuery(q ?? "");
  const words = norm(rest).split(" ").filter(Boolean);
  // First, so the word still being typed stays last (it alone may match as a 1-letter start).
  if (catalog) words.unshift(compact(catalog[0]));
  return [...new Set(words)];
}

export function searchCatalog<T extends SearchDoc>(
  index: SearchIndex<T>,
  q: string,
  opts: { priority?: string[]; picked?: Map<string, number> } = {},
): SearchResult<T> {
  const typed = queryWords(q);
  const priority = (opts.priority ?? []).map(norm).filter(Boolean);
  // An item without that category still counts when its name carries the brand ("ARTLINE ...", "V-TEC ...",
  // "GM ..."), but "21 GM" after a number is grams, not the brand.
  const brandWord = priority.map((p) => compact(p.startsWith("v ") ? p : p.split(" ")[0]));
  const afterNumber = brandWord.map((b) => new RegExp(`\\d ${b}( |$)`));
  const ranks = new Map<number, number>();
  const rank = (i: number) => {
    let r = ranks.get(i);
    if (r !== undefined) return r;
    const cat = index.category[i];
    r = priority.findIndex((x) => cat === x || cat.startsWith(x + " "));
    if (r < 0) r = brandWord.findIndex((b, k) => b.length >= 2 && index.words[i].includes(b) && !afterNumber[k].test(index.name[i]));
    if (r < 0) r = priority.length;
    ranks.set(i, r);
    return r;
  };
  if (!typed.length) {
    const order = index.docs.map((_, i) => i).sort((a, b) => rank(a) - rank(b) || index.docs[a].name.localeCompare(index.docs[b].name));
    return { items: order.map((i) => index.docs[i]), partial: false, suggestion: null };
  }

  const perWord = typed.map((w, k) => wordScores(index.vocab, w, k === typed.length - 1));
  // A piece of a code typed whole ("k-001", "tk001") finds the item, as code LIKE %q% did.
  const qCode = compact(q);
  const scored: { i: number; hits: number; score: number; typo: boolean }[] = [];
  for (let i = 0; i < index.docs.length; i++) {
    let hits = 0;
    let score = 0;
    let typo = false;
    for (const { scores } of perWord) {
      let best = 0;
      for (const w of index.words[i]) {
        const s = scores.get(w);
        if (s && s > best) best = s;
      }
      if (best > 0) hits++, (score += best), (typo ||= best === TYPO);
    }
    if (qCode.length >= 3 && hits < typed.length && compact(index.docs[i].code).includes(qCode)) (hits = typed.length), (score = typed.length * 0.9), (typo = false);
    if (hits) scored.push({ i, hits, score, typo });
  }

  const all = scored.filter((s) => s.hits === typed.length);
  const partial = !all.length && typed.length > 1;
  const pool = all.length ? all : partial ? scored.filter((s) => s.hits === typed.length - 1) : [];
  const first = typed[0];
  // Habit: picked after these very words first; then popularity as a small bonus (at most 0.3, a bit
  // more than prefix vs exact on one word) so a common item beats a rare one that matches the same.
  const picked = opts.picked ?? new Map<string, number>();
  const pickOf = (i: number) => picked.get(index.docs[i].code) ?? 0;
  const maxPop = Math.max(1, ...pool.map((s) => index.docs[s.i].popularity ?? 0));
  for (const s of pool) s.score += 0.3 * (Math.log1p(index.docs[s.i].popularity ?? 0) / Math.log1p(maxPop));
  pool.sort(
    (a, b) =>
      Number(a.typo) - Number(b.typo) ||
      pickOf(b.i) - pickOf(a.i) ||
      rank(a.i) - rank(b.i) ||
      b.score - a.score ||
      Number(!index.name[a.i].startsWith(first)) - Number(!index.name[b.i].startsWith(first)) ||
      index.docs[a.i].name.length - index.docs[b.i].name.length ||
      index.docs[a.i].name.localeCompare(index.docs[b.i].name),
  );

  let suggestion: string | null = null;
  if (perWord.some((p) => p.typoOnly && p.best)) {
    suggestion = typed.map((w, k) => (perWord[k].typoOnly && perWord[k].best ? perWord[k].best! : w)).join(" ");
  }
  return { items: pool.map((s) => index.docs[s.i]), partial, suggestion };
}
