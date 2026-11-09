/* Re-ranking near-equal candidates (Ryoma, 2026-11-09): in a list of 100 lines, 80 waited on a rep and
   the first suggestion was often a variant nobody sells ("Pulpen Gel Artline" → a gel pen with stock 0,
   0.875, over the stocked one at 0.857). Among candidates within RANK_BAND of the best score, the one
   the sales team actually sells comes first, then one in stock, then a priority brand. Never changes a
   status, never moves a candidate pinned by code, alias or invoice, never lets a worse match jump a band. */

import type { MatchResult } from "./match.js";

export const RANK_BAND = 0.03;

export interface RankFacts {
  /** SI lines of this item in the last 12 months. */
  sold: number;
  inStock: boolean;
  priorityBrand: boolean;
}

/** Returns new results; the band of a "review" by name is re-ordered, everything else is as given. */
export function rerankCandidates(results: MatchResult[], facts: Map<number, RankFacts>): MatchResult[] {
  return results.map((r) => {
    if (r.via !== "name" || r.status !== "review" || r.candidates.length < 2) return r;
    const best = r.candidates[0].score;
    const band = r.candidates.filter((c) => c.score >= best - RANK_BAND);
    if (band.length < 2) return r;
    const f = (id: number) => facts.get(id) ?? { sold: 0, inStock: false, priorityBrand: false };
    const order = new Map(r.candidates.map((c, i) => [c.id, i]));
    const ranked = [...band].sort(
      (a, b) =>
        f(b.id).sold - f(a.id).sold ||
        Number(f(b.id).inStock) - Number(f(a.id).inStock) ||
        Number(f(b.id).priorityBrand) - Number(f(a.id).priorityBrand) ||
        order.get(a.id)! - order.get(b.id)!,
    );
    return { ...r, candidates: [...ranked, ...r.candidates.slice(band.length)] };
  });
}
