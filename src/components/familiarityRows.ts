/* The familiarity workbench's state, with nothing rendered: which filter a row
   falls under, what it offers, and how the server's answer folds back in. */

import type { RequestLine } from "@shared/match";
import type { FamiliarityCandidate, FamiliarityRow } from "@shared/familiarity";
import type { FeedLine } from "../familiarityApi";

export type Filter = "all" | "todo" | "familiar";

/** No person or rule has settled it, and the matcher was unsure ("Mirip") or had nothing ("Adjustment"). */
export const needsWork = (r: FamiliarityRow): boolean => r.status === "mirip" || r.status === "adjustment";

/** Settled onto an item, here or by a rule stored earlier. A header is settled but not familiar. */
export const isFamiliar = (r: FamiliarityRow): boolean => !!r.resolved && r.resolved.action !== "ignore_row";

export function workbenchCounts(rows: FamiliarityRow[]) {
  return {
    all: rows.length,
    todo: rows.filter(needsWork).length,
    familiar: rows.filter(isFamiliar).length,
    adjustment: rows.filter((r) => r.status === "adjustment").length,
    review: rows.filter((r) => r.status === "mirip").length,
  };
}

export function filterRows(rows: FamiliarityRow[], filter: Filter): FamiliarityRow[] {
  if (filter === "todo") return rows.filter(needsWork);
  if (filter === "familiar") return rows.filter(isFamiliar);
  return rows;
}

/** A resolve answers with every row it settled (the twins too): replace those, keep the rest. */
export function mergeRows(rows: FamiliarityRow[], updated: FamiliarityRow[]): FamiliarityRow[] {
  const byId = new Map(updated.map((r) => [r.id, r]));
  return rows.map((r) => byId.get(r.id) ?? r);
}

export const sameCandidate = (a: Pick<FamiliarityCandidate, "source" | "item_id" | "pending_item_id">, b: typeof a): boolean =>
  a.source === b.source && (a.source === "catalog" ? a.item_id === b.item_id : a.pending_item_id === b.pending_item_id);

/** What the row is paired with now: the settled choice, else the matcher's best guess. */
export function currentPairing(r: FamiliarityRow): { label: string; candidate: FamiliarityCandidate | null } {
  if (r.resolved) {
    if (r.resolved.action === "ignore_row") return { label: "Bukan barang / header", candidate: null };
    const c = r.candidates.find((x) =>
      r.resolved!.action === "create_new_item" ? x.pending_item_id === r.resolved!.pending_item_id : x.item_id === r.resolved!.item_id,
    );
    return { label: `${r.resolved.name}${r.resolved.code ? ` (${r.resolved.code})` : ""}`, candidate: c ?? null };
  }
  const top = r.candidates[0];
  return { label: top ? `${top.name} (${top.code})` : "—", candidate: top ?? null };
}

/** The likely answers, best first, without the one already in place when correcting. */
export function pillsFor(r: FamiliarityRow, excludeCurrent: boolean, max = 4): FamiliarityCandidate[] {
  const now = excludeCurrent ? currentPairing(r).candidate : null;
  return r.candidates.filter((c) => !(now && sameCandidate(c, now))).slice(0, max);
}

export type RowMode = "todo" | "auto" | "settled";

/**
 * "todo": nothing settled it yet. "auto": the matcher was sure on its own, by
 * name or by code, which is still a guess (CGV's codes collided with ours) and
 * can be confirmed or corrected. "settled": a rule or a person decided it; it
 * can still be corrected.
 */
export function rowMode(r: FamiliarityRow): RowMode {
  if (r.resolved) return "settled";
  return needsWork(r) ? "todo" : "auto";
}

/** A pasted list: one item per line; bullets, numbering and extra spreadsheet cells dropped. */
export function linesFromPaste(text: string): RequestLine[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.split("\t")[0].replace(/^\s*(?:[-*•·]|\d+[.)])\s*/, "").trim())
    .filter(Boolean)
    .map((name) => ({ name: name.slice(0, 300) }));
}

/**
 * Lines as the feed takes them. The name is the text, the code stays its own
 * field: the same split "Dari list klien" sends to /catalog/match, so a rule
 * stored here is found there under the same wording.
 */
export function feedLines(lines: RequestLine[]): FeedLine[] {
  return lines.map((l) => {
    const qty = Number(l.qty);
    const unit = (l.uom ?? "").trim().slice(0, 32);
    const code = (l.code ?? "").trim().slice(0, 64);
    return {
      text: l.name.slice(0, 3000),
      ...(l.qty != null && Number.isFinite(qty) && qty >= 0 ? { qty } : {}),
      ...(unit ? { unit } : {}),
      ...(code ? { code } : {}),
    };
  });
}
