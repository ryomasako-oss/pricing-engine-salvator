/* ============================================================
   Interactive familiarity — the shape the Worker returns.

   A "feed" turns a client's request list into a session of rows. The
   matcher guesses, a human resolves one row, and every row in the same
   session with the same normalized wording follows (see
   server/familiarity.ts). Nothing here creates a quotation.
   ============================================================ */

import type { MatchStatus } from "./match.js";

export type FamiliarityRowStatus = "pasti" | "mirip" | "adjustment" | "resolved";

export type FamiliarityAction = "verify_item" | "create_new_item" | "ignore_row" | "reject_candidate";

export interface FamiliaritySummary {
  total: number;
  /** Strong auto-matches, still waiting for a human. */
  pasti: number;
  /** Similar candidates, a human should pick. */
  mirip: number;
  /** Nothing scored: a new item or an ignored line. */
  adjustment: number;
  /** A human (or a stored rule) has settled the row. */
  resolved: number;
}

export interface FamiliarityCandidate {
  source: "catalog" | "pending";
  /** Catalog id as a string; null for a pending item. */
  item_id: string | null;
  /** Pending request id; null for a catalog item. */
  pending_item_id: number | null;
  code: string;
  name: string;
  uom: string;
  score: number;
}

export interface FamiliarityMatch {
  /** The matcher's own verdict, before any human rule. */
  status: MatchStatus;
  via: "code" | "alias" | "name" | "rule" | null;
  score: number;
  item_id: string | null;
  pending_item_id: number | null;
}

export interface FamiliarityResolved {
  action: FamiliarityAction;
  item_id: string | null;
  pending_item_id: number | null;
  code: string | null;
  name: string;
  /** The wording this resolution was stored under. */
  normalized_raw_text: string;
}

export interface FamiliarityRow {
  id: number;
  line_no: number;
  raw_text: string;
  normalized_raw_text: string;
  qty: number;
  unit: string;
  status: FamiliarityRowStatus;
  match: FamiliarityMatch;
  candidates: FamiliarityCandidate[];
  /** null while the row is still waiting for a human. */
  resolved: FamiliarityResolved | null;
}

export interface FamiliaritySessionView {
  session_id: number;
  summary: FamiliaritySummary;
  rows: FamiliarityRow[];
}

export const emptySummary = (): FamiliaritySummary => ({ total: 0, pasti: 0, mirip: 0, adjustment: 0, resolved: 0 });

/** How a stored matcher verdict reads to the person reviewing the list. */
export function rowStatus(row: { resolved_at: string | null; match_status: string }): FamiliarityRowStatus {
  if (row.resolved_at) return "resolved";
  if (row.match_status === "exact" || row.match_status === "match") return "pasti";
  if (row.match_status === "review") return "mirip";
  return "adjustment";
}

/** The summary both the feed and the resolve response report. */
export function summaryOf(rows: { resolved_at: string | null; match_status: string }[]): FamiliaritySummary {
  const out = emptySummary();
  out.total = rows.length;
  for (const r of rows) out[rowStatus(r)]++;
  return out;
}

/** A candidate from a matcher id: catalog ids are positive, pending ids negative. */
export function candidateKey(c: Pick<FamiliarityCandidate, "source" | "item_id" | "pending_item_id">): string {
  return c.source === "catalog" ? `catalog:${c.item_id}` : `pending:${c.pending_item_id}`;
}
