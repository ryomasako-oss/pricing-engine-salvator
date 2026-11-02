/* Unit-of-measure conversion for quote lines.

   Each catalog item has a base unit (catalog_items.uom, factor 1) plus
   optional extra units with a per-item ratio: "Box = 24" means one Box holds
   24 base units. Ratios are per item because a Box of pens and a Box of
   clips hold different amounts. They come from Accurate's Satuan #2-#5 /
   Rasio columns or from the catalog edit form.

   A line's cogs/rrp/manualPrice are always "per the line's unit", so the
   pricing engine, policy checks and quotation document stay unit-agnostic.
   Switching a line's unit rescales all three by newFactor / oldFactor. When
   either ratio is unknown, the unit label still changes but the numbers do
   not, and `priceUom` records which unit the numbers are really in, so the
   UI can warn and a later switch still converts from the right unit. The
   warning clears only when the rep marks the line as checked (both COGS and
   RRP), never implicitly from editing one of them. */

import type { QuoteItem, UnitFactor } from "./types.js";

export interface ItemUnits {
  baseUom: string;
  units: UnitFactor[];
}

const norm = (u: string) => u.trim().toLowerCase();

export const sameUom = (a: string, b: string) => norm(a) === norm(b);

/* Two decimals. Rupiah values are whole numbers in practice, but a ratio
   that doesn't divide evenly (25,000 per Box of 24 -> 1,041.67 per Pcs)
   needs cents so a round trip lands within Rp 1 of where it started. */
const round2 = (x: number) => Math.round(x * 100) / 100;

/** Base units in one `uom` for this item, or undefined when no ratio is known. */
export function unitFactor(units: ItemUnits | undefined, uom: string): number | undefined {
  if (!units) return undefined;
  if (sameUom(uom, units.baseUom)) return 1;
  const f = units.units.find((u) => sameUom(u.uom, uom))?.factor;
  return f && f > 0 ? f : undefined;
}

/**
 * Normalises an item's extra units before storing: drops the base unit itself
 * (its factor is always 1), blank names and non-positive ratios, and keeps
 * the first of any case-insensitive duplicates.
 */
export function cleanUnits(baseUom: string | undefined, units: UnitFactor[]): UnitFactor[] {
  const out: UnitFactor[] = [];
  for (const u of units) {
    const uom = u.uom.trim();
    if (!uom || !(u.factor > 0)) continue;
    if (baseUom && sameUom(uom, baseUom)) continue;
    if (out.some((o) => sameUom(o.uom, uom))) continue;
    out.push({ uom, factor: u.factor });
  }
  return out;
}

/* ---------------- unit written in a client's wording ---------------- */

/** How a client writes a pack unit -> the spellings a catalog may use for it, best first. */
const PACK_UNITS: Record<string, string[]> = {
  lusin: ["Lusin", "LSN"],
  lsn: ["Lusin", "LSN"],
  gross: ["Gross", "GRS"],
  grs: ["Gross", "GRS"],
  box: ["Box", "KTK", "Kotak"],
  kotak: ["KTK", "Kotak", "Box"],
  ktk: ["KTK", "Kotak", "Box"],
  dus: ["Dus", "DUS"],
  karton: ["Karton", "CRT"],
  crt: ["Karton", "CRT"],
  pack: ["Pack", "Pak", "PAK"],
  pak: ["Pack", "Pak", "PAK"],
  rim: ["Rim", "RIM"],
};

/** Units whose absence from an item is worth a warning: a lusin is 12 and a gross 144, so a missing ratio changes the margin. */
const WARN_IF_MISSING = new Set(["lusin", "lsn", "gross", "grs"]);

/** Pack unit a client wrote in the line's name, with the count they gave when it is "isi N/unit". */
function readPackText(name: string): { word: string; count?: number } | undefined {
  const text = (name ?? "").toLowerCase();
  const isi = /\bisi\s*(\d+)\s*(?:[a-z]+\s*)?\/\s*([a-z]+)\b/.exec(text); // isi 12/lusin, isi 10 kotak/box
  if (isi && PACK_UNITS[isi[2]]) return { word: isi[2], count: Number(isi[1]) };
  const at = /\b\d+\s*([a-z]+)\s*@\s*\d+/.exec(text); // 1 gross @12 pack, 1 box @6 pcs
  if (at && PACK_UNITS[at[1]]) return { word: at[1] };
  return undefined;
}

/** Pack unit a client wrote in the line's name: "(isi 12/Lusin)", "(1 Gross @12 Pack)", "( ISI 10 KOTAK/BOX )". */
export const packUnitWord = (name: string): string | undefined => readPackText(name)?.word;

/**
 * The unit a client's wording asks for, in the item's own spelling, when the item has it.
 * - `uom`: the item really has the unit (its base, or an extra unit with a ratio) and, for a
 *   lusin written "isi 12/Lusin", the catalog's ratio agrees with the 12.
 * - `unmatched`: a lusin/gross the item does not have, so the line can say so instead of
 *   silently pricing a lusin against a per-piece cost.
 * - `conflict`: the wording and the catalog disagree on how many are in a lusin. Nothing is
 *   applied: one of the two is wrong and a person must look.
 * The catalog's ratios come from Accurate and the edit form and change over time, so every
 * use of this is shown on the row, never silent.
 */
export function readPackUnit(
  name: string,
  item: { uom?: string; units?: UnitFactor[] },
): { uom?: string; unmatched?: string; conflict?: { word: string; text: number; catalog: number } } {
  const read = readPackText(name);
  if (!read) return {};
  const base = item.uom || "Pcs";
  for (const candidate of PACK_UNITS[read.word]) {
    if (sameUom(candidate, base)) return { uom: base };
    const extra = (item.units ?? []).find((u) => sameUom(u.uom, candidate) && u.factor > 0);
    if (!extra) continue;
    if ((read.word === "lusin" || read.word === "lsn") && read.count && extra.factor !== read.count) {
      return { conflict: { word: read.word, text: read.count, catalog: extra.factor } };
    }
    return { uom: extra.uom };
  }
  return WARN_IF_MISSING.has(read.word) ? { unmatched: read.word } : {};
}

/** The unit this line's numbers are actually expressed in. */
export const priceUnitOf = (line: QuoteItem) => line.priceUom ?? line.uom;

/** Switches a line's unit, rescaling COGS, RRP and any manual price. */
export function changeLineUom(line: QuoteItem, to: string, units?: ItemUnits): QuoteItem {
  const from = priceUnitOf(line);
  if (sameUom(from, to)) return { ...line, uom: to, priceUom: undefined };

  const fFrom = unitFactor(units, from);
  const fTo = unitFactor(units, to);
  if (fFrom === undefined || fTo === undefined) return { ...line, uom: to, priceUom: from };

  const r = fTo / fFrom;
  return {
    ...line,
    uom: to,
    priceUom: undefined,
    cogs: round2(line.cogs * r),
    ...(line.catalogCogs != null ? { catalogCogs: round2(line.catalogCogs * r) } : {}),
    rrp: round2(line.rrp * r),
    manualPrice: line.manualPrice?.map((p) => (p === null ? null : round2(p * r))),
  };
}

/** Human-readable warning when the line's numbers are not in its shown unit. */
export function uomWarning(line: QuoteItem): string | null {
  if (!line.priceUom || sameUom(line.priceUom, line.uom)) return null;
  return `Rasio ${line.uom} belum ada: COGS/RRP masih per ${line.priceUom}, cek manual`;
}

/** A per-unit amount (a ceiling, a price) re-expressed per `to`; null when either unit has no known ratio. */
export function amountInUnit(units: ItemUnits | undefined, from: string, to: string, amount: number): number | null {
  const fFrom = unitFactor(units, from);
  const fTo = unitFactor(units, to);
  return fFrom === undefined || fTo === undefined ? null : round2((amount * fTo) / fFrom);
}

/** The line's COGS/RRP expressed per base unit, or null when it can't be converted. */
export function toBaseUnit(line: QuoteItem, units: ItemUnits): { cogs: number; rrp: number } | null {
  const f = unitFactor(units, priceUnitOf(line));
  if (f === undefined) return null;
  return { cogs: round2(line.cogs / f), rrp: round2(line.rrp / f) };
}

/**
 * Units offered in a line's dropdown: the item's own base and extra units
 * first (Accurate may use e.g. "BTL", which isn't in the managed list), then
 * the managed list, then the line's current unit if still missing.
 * Case-insensitive de-dup, first spelling wins.
 */
export function uomChoices(managed: string[], units: ItemUnits | undefined, current: string): string[] {
  const out: string[] = [];
  const add = (u: string) => {
    if (u.trim() && !out.some((o) => sameUom(o, u))) out.push(u);
  };
  if (units) {
    add(units.baseUom);
    units.units.forEach((u) => add(u.uom));
  }
  managed.forEach(add);
  add(current);
  // A <select> needs an option whose value equals the current value exactly,
  // so the line's own spelling wins ("Pcs" on the line vs "PCS" from Accurate).
  return out.map((u) => (sameUom(u, current) ? current : u));
}
