/* ============================================================
   Draft "Dari list klien" (Ryoma, 2026-10-23): a client's list that was
   read and partly matched can be saved, reopened later, and sent to a PIC
   who finishes it into a quotation (server/listDrafts.ts stores it,
   src/components/ListToQuote.tsx edits it).

   A draft keeps the person's work, never the catalog's numbers: each row's
   pick is a catalog code (or the barang baru it requested). Opening a
   draft matches its lines again and restoreRows() lays the picks over
   that fresh result, so prices and COGS are always today's and always
   filtered for whoever opens it.
   ============================================================ */

import type { MatchResult, RequestLine } from "./match.js";
import type { CatalogItem } from "./types.js";

/** One row's pick: a catalog item by code, or a barang baru (pending request, which has no COGS). */
export type DraftPick =
  | { kind: "catalog"; code: string }
  | { kind: "pending"; pendingId: number; code: string; name: string; uom: string; price: number };

export interface DraftChoice {
  /** null: the row is left out of the quote. */
  chosen: DraftPick | null;
  /** The person accepted or changed the pairing. */
  confirmed: boolean;
  /** Codes found by a manual search for this row, kept as options in its dropdown. */
  extra: string[];
}

export type DraftStatus = "open" | "done" | "cancelled";

/** A draft as the list on the Dashboard shows it. */
export interface DraftSummary {
  id: number;
  title: string;
  client_id: number | null;
  client_name: string | null;
  file_name: string;
  rows: number;
  status: DraftStatus;
  created_by: number;
  created_by_name: string;
  assigned_to: number | null;
  assigned_to_name: string | null;
  assign_note: string;
  assigned_at: string | null;
  quote_id: number | null;
  version: number;
  updated_at: string;
}

export interface Draft extends DraftSummary {
  notes: string[];
  lines: RequestLine[];
  choices: DraftChoice[];
}

/** The row state ListToQuote edits; ids are catalog ids (negative for a barang baru). */
export interface EditorRow {
  request: RequestLine;
  result: MatchResult;
  chosen: number | null;
  confirmed: boolean;
  extra: number[];
}

/** The rows' picks as a draft stores them. */
export function choicesFromRows(rows: EditorRow[], items: Map<number, CatalogItem>): DraftChoice[] {
  return rows.map((r) => {
    const item = r.chosen != null ? items.get(r.chosen) : undefined;
    const chosen: DraftPick | null = !item
      ? null
      : item.source === "pending"
        ? { kind: "pending", pendingId: -item.id, code: item.code, name: item.name, uom: item.uom, price: Number(item.list_price) || 0 }
        : { kind: "catalog", code: item.code };
    const extra = r.extra.map((id) => items.get(id)).filter((i): i is CatalogItem => !!i && i.source !== "pending").map((i) => i.code);
    return { chosen, confirmed: !!chosen && r.confirmed, extra };
  });
}

/** Codes a draft points at that a fresh match may not have returned (picked by hand). */
export function codesToFetch(choices: DraftChoice[], items: CatalogItem[]): string[] {
  const have = new Set(items.filter((i) => i.source !== "pending").map((i) => i.code.toLowerCase()));
  const want = new Set<string>();
  for (const c of choices) {
    for (const code of [...(c.chosen?.kind === "catalog" ? [c.chosen.code] : []), ...c.extra]) {
      if (!have.has(code.toLowerCase())) want.add(code);
    }
  }
  return [...want];
}

/** A barang baru as the editor holds it (NewItemForm's shape): negative id, no COGS. */
export function pendingAsItem(p: Extract<DraftPick, { kind: "pending" }>): CatalogItem {
  return { id: -p.pendingId, code: p.code, name: p.name, uom: p.uom, cogs: 0, list_price: p.price, stock: 0, category: "", source: "pending", updated_at: "" };
}

/**
 * Lays a draft's picks over a fresh match. `items` is everything the editor
 * knows: the match's items plus those fetched for codesToFetch(). A pick
 * whose item is gone is cleared and left unconfirmed rather than replaced by
 * a guess; `lost` counts those so the editor can say so. A barang baru that
 * has since reached the catalog under its code is used as the catalog item.
 */
export function restoreRows(
  lines: RequestLine[],
  results: MatchResult[],
  choices: DraftChoice[],
  items: Map<number, CatalogItem>,
): { rows: EditorRow[]; extraItems: CatalogItem[]; lost: number } {
  const byCode = new Map<string, CatalogItem>();
  for (const i of items.values()) if (i.source !== "pending") byCode.set(i.code.toLowerCase(), i);
  const extraItems: CatalogItem[] = [];
  let lost = 0;
  const rows = results.map((result): EditorRow => {
    const fresh: EditorRow = {
      request: lines[result.index],
      result,
      chosen: result.status === "none" ? null : result.candidates[0]?.id ?? null,
      confirmed: result.status === "exact" || result.status === "match",
      extra: [],
    };
    const saved = choices[result.index];
    if (!saved) return fresh;
    const extra = saved.extra.map((code) => byCode.get(code.toLowerCase())?.id).filter((id): id is number => id != null);
    if (!saved.chosen) return { ...fresh, chosen: null, confirmed: saved.confirmed, extra };
    let id: number | undefined;
    if (saved.chosen.kind === "catalog") id = byCode.get(saved.chosen.code.toLowerCase())?.id;
    else {
      id = byCode.get(saved.chosen.code.toLowerCase())?.id;
      if (id == null) {
        const p = pendingAsItem(saved.chosen);
        extraItems.push(p);
        id = p.id;
      }
    }
    if (id == null) {
      lost++;
      return { ...fresh, chosen: null, confirmed: false, extra };
    }
    const inOptions = result.candidates.some((c) => c.id === id) || extra.includes(id);
    return { ...fresh, chosen: id, confirmed: saved.confirmed, extra: inOptions ? extra : [...extra, id] };
  });
  return { rows, extraItems, lost };
}
