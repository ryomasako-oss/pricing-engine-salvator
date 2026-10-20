/* Pembelajaran pencocokan (Ryoma, 2026-10-16).

   Every row of a reviewed client list is recorded, right or wrong
   (migrations/0018_match_learning.sql), so three questions can be answered
   that nothing could answer before: how often the matcher is right, which
   wording it keeps missing, and which pairing a rep has already thrown away.

   The last one feeds back into matching: a pairing rejected and never
   accepted is pushed below the auto-accept line, so the same wrong guess
   stops being offered as a certainty. Only that — the matcher is arithmetic
   (shared/match.ts) and stays arithmetic; this adds memory, not a model. */

import type { MatchStatus } from "./match.js";

export type Outcome = "accepted" | "corrected" | "dropped" | "new_item";

export interface FeedbackRow {
  text: string;
  rawText: string;
  status: MatchStatus;
  via: string;
  /** Top candidate's code, or null when the matcher offered none. */
  suggested: string | null;
  score: number;
  /** The code the rep used, or null when the row was left out. */
  chosen: string | null;
  /** The chosen item is a "barang baru" request, not a catalog row. */
  isNew?: boolean;
}

/** What the rep's decision says about the matcher's guess. */
export function outcomeOf(r: Pick<FeedbackRow, "suggested" | "chosen" | "isNew">): Outcome {
  if (r.isNew) return "new_item";
  if (!r.chosen) return "dropped";
  return r.suggested && r.suggested === r.chosen ? "accepted" : "corrected";
}

/**
 * A guess the matcher offered and the rep replaced. "dropped" is not a
 * rejection of the pairing: the rep may simply not be quoting that line.
 */
export const isRejection = (r: { outcome: Outcome; suggested: string | null }) =>
  r.outcome === "corrected" && !!r.suggested;

/* ---------- the penalty ---------- */

/** Rejected text → codes. Built from feedback where rejections outnumber acceptances. */
export type Rejected = Map<string, Set<string>>;

/**
 * How much a rejected pairing's score is cut. 0.5 puts a 0.9 "certain" match
 * at 0.45, the review line: still offered as an alternative, never
 * auto-accepted again. It is not dropped outright because one rep's
 * correction can itself be the mistake.
 */
export const REJECTED_PENALTY = 0.5;

export const isRejectedPair = (rejected: Rejected | undefined, text: string, code: string): boolean =>
  !!rejected?.get(text)?.has(code);

/* ---------- the report ---------- */

export interface WeekPoint {
  /** Monday of the week, YYYY-MM-DD. */
  week: string;
  accepted: number;
  corrected: number;
}

export interface MissedTerm {
  text: string;
  rawText: string;
  corrected: number;
  /** What the matcher keeps offering, and what the rep keeps choosing instead. */
  suggested: string | null;
  chosen: string | null;
}

export interface LearningReport {
  rows: number;
  accepted: number;
  corrected: number;
  dropped: number;
  newItem: number;
  /** accepted / (accepted + corrected), or null when nothing has been judged yet. */
  accuracy: number | null;
  weeks: WeekPoint[];
  topMissed: MissedTerm[];
  /** Pairings that have become rules (catalog_aliases). */
  aliases: number;
  /** Pairings the matcher is now penalised for. */
  rejectedPairs: number;
}

export const accuracyOf = (accepted: number, corrected: number): number | null =>
  accepted + corrected > 0 ? accepted / (accepted + corrected) : null;

/** Monday of the week an ISO date falls in, in WIB. */
export function weekOf(iso: string): string {
  const t = Date.parse(iso.includes("T") ? iso : `${iso.replace(" ", "T")}Z`);
  if (!Number.isFinite(t)) return "";
  const d = new Date(t + 7 * 3_600_000);
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  return new Date(d.getTime() - day * 86_400_000).toISOString().slice(0, 10);
}

/** What the panel says about the figure, in one line. */
export function accuracyNote(r: LearningReport): string {
  if (r.accuracy === null) return "Belum ada baris yang dinilai. Angka muncul setelah baris dibereskan di Pencocokan atau quotation dibuat dari list klien.";
  const pct = (r.accuracy * 100).toFixed(0);
  if (r.rows < 50) return `${pct}% tebakan teratas dipakai apa adanya, dari ${r.rows} baris. Masih sedikit, jadi angkanya belum stabil.`;
  return `${pct}% tebakan teratas dipakai apa adanya, dari ${r.rows} baris.`;
}
