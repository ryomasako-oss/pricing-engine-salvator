/* Server side of the matching feedback (shared/matchLearning.ts): the SQL the
   Worker runs.

   Recording is an observation, so it happens for every reviewed row, with or
   without a client. Turning a pairing into a RULE still needs a client
   (catalog_aliases, POST /catalog/aliases) — one hurried "Benar" must not
   become a company-wide rule.

   Rejections are applied across clients, unlike aliases. A pairing one rep
   threw away is usually a bad guess for everyone, and the penalty only ever
   demotes a candidate (shared/matchLearning.ts REJECTED_PENALTY): the item
   stays on the list, it just stops being auto-accepted. */

import { z } from "zod";
import { normalizeText } from "../shared/match.js";
import { outcomeOf, weekOf, type FeedbackRow, type LearningReport, type MissedTerm, type WeekPoint, accuracyOf } from "../shared/matchLearning.js";

/** One list may be long; the review screen caps a quote at MAX_LINES (500). */
export const feedbackRowSchema = z.object({
  text: z.string().trim().min(1).max(300),
  status: z.enum(["exact", "match", "review", "none"]),
  via: z.string().max(8).default(""),
  suggested: z.string().max(64).nullable().default(null),
  score: z.number().min(0).max(1).default(0),
  chosen: z.string().max(64).nullable().default(null),
  isNew: z.boolean().default(false),
});

export const feedbackSchema = z.object({
  client_id: z.number().int().min(0).optional(),
  rows: z.array(feedbackRowSchema).max(2000).default([]),
});

export type FeedbackInput = z.infer<typeof feedbackSchema>;

/** Rows ready for INSERT_FEEDBACK_SQL: normalised text and the outcome decided here, once. */
export function feedbackRows(input: FeedbackInput, userId: number) {
  return input.rows.map((r) => ({
    client_id: input.client_id ?? 0,
    text: normalizeText(r.text),
    raw_text: r.text,
    status: r.status,
    via: r.via ?? "",
    suggested: r.suggested || null,
    score: r.score ?? 0,
    chosen: r.chosen || null,
    outcome: outcomeOf(r as FeedbackRow),
    user_id: userId,
  }));
}

/** One statement for the whole list: D1 charges per statement, not per batch. */
export const INSERT_FEEDBACK_SQL = `
  INSERT INTO match_feedback(client_id, text, raw_text, status, via, suggested, score, chosen, outcome, user_id)
  SELECT json_extract(j.value, '$.client_id'), json_extract(j.value, '$.text'), json_extract(j.value, '$.raw_text'),
         json_extract(j.value, '$.status'), json_extract(j.value, '$.via'), json_extract(j.value, '$.suggested'),
         json_extract(j.value, '$.score'), json_extract(j.value, '$.chosen'), json_extract(j.value, '$.outcome'),
         json_extract(j.value, '$.user_id')
    FROM json_each(?1) j WHERE true`;

/**
 * Pairings to penalise: a wording and a code the reps replaced more often than
 * they kept. Across clients on purpose (see the header).
 */
export const REJECTED_SQL = `
  SELECT text, suggested FROM match_feedback
   WHERE suggested IS NOT NULL AND suggested <> ''
   GROUP BY text, suggested
  HAVING SUM(CASE WHEN outcome = 'corrected' THEN 1 ELSE 0 END)
       > SUM(CASE WHEN outcome = 'accepted' THEN 1 ELSE 0 END)`;

export function rejectedMap(rows: { text: string; suggested: string }[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const r of rows) {
    const set = out.get(r.text) ?? new Set<string>();
    set.add(r.suggested);
    out.set(r.text, set);
  }
  return out;
}

/* ---------- the report ---------- */

export const COUNTS_SQL = `
  SELECT outcome, COUNT(*) AS n FROM match_feedback GROUP BY outcome`;

/** Judged rows per week; dropped and new_item say nothing about the guess. */
export const WEEKS_SQL = `
  SELECT created_at, outcome FROM match_feedback
   WHERE outcome IN ('accepted', 'corrected') AND created_at >= datetime('now', '-70 days')`;

export const MISSED_SQL = `
  SELECT text, MAX(raw_text) AS raw_text, COUNT(*) AS corrected,
         MAX(suggested) AS suggested, MAX(chosen) AS chosen
    FROM match_feedback
   WHERE outcome = 'corrected'
   GROUP BY text
   ORDER BY corrected DESC, text
   LIMIT ?1`;

export const TOP_MISSED = 15;

export function buildReport(input: {
  counts: { outcome: string; n: number }[];
  weeks: { created_at: string; outcome: string }[];
  missed: { text: string; raw_text: string; corrected: number; suggested: string | null; chosen: string | null }[];
  aliases: number;
  rejectedPairs: number;
}): LearningReport {
  const n = (k: string) => input.counts.find((c) => c.outcome === k)?.n ?? 0;
  const accepted = n("accepted");
  const corrected = n("corrected");
  const byWeek = new Map<string, WeekPoint>();
  for (const r of input.weeks) {
    const week = weekOf(r.created_at);
    if (!week) continue;
    const p = byWeek.get(week) ?? { week, accepted: 0, corrected: 0 };
    if (r.outcome === "accepted") p.accepted++;
    else p.corrected++;
    byWeek.set(week, p);
  }
  return {
    rows: input.counts.reduce((s, c) => s + c.n, 0),
    accepted,
    corrected,
    dropped: n("dropped"),
    newItem: n("new_item"),
    accuracy: accuracyOf(accepted, corrected),
    weeks: [...byWeek.values()].sort((a, b) => a.week.localeCompare(b.week)),
    topMissed: input.missed.map(
      (m): MissedTerm => ({ text: m.text, rawText: m.raw_text, corrected: m.corrected, suggested: m.suggested, chosen: m.chosen }),
    ),
    aliases: input.aliases,
    rejectedPairs: input.rejectedPairs,
  };
}
