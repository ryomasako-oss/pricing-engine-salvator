/* What a row of the list→quotation review shows in its status column.

   This was a four-deep ternary inside the JSX, and a state hid in it: a row
   the matcher could not resolve kept reading "Adjustment" after the rep had
   already picked an item for it, while a "perlu dicek" row cleared to "Sudah
   dicek". Pulling the decision out makes every state nameable and testable —
   JSX is not, which is how the same class of bug passed typecheck and 426
   tests on 2026-10-16. */

import type { MatchStatus } from "@shared/match";
import { PENDING_BADGE } from "@shared/pendingItems";

export const STATUS_LABEL: Record<MatchStatus, { text: string; cls: string }> = {
  exact: { text: "Pasti", cls: "green" },
  match: { text: "Cocok", cls: "green" },
  review: { text: "Perlu dicek", cls: "amber" },
  // Ryoma (catatan 23): a row with no candidate is something the rep adjusts, not a failure.
  none: { text: "Adjustment", cls: "blue" },
};

/** The facts a row's status column depends on, with nothing else attached. */
export interface RowState {
  status: MatchStatus;
  /** An item is selected for this row (a catalog row or a "barang baru"). */
  chosen: boolean;
  /** The rep accepted or changed the pairing. */
  confirmed: boolean;
  /** The selected item is a "barang baru" waiting for Accurate. */
  pending: boolean;
  /** The selected item's COGS must not be sold on (cogsCheck). */
  held: boolean;
}

export type RowBadge =
  /** Not a badge: the rep still has to accept the suggestion. */
  | { kind: "confirm" }
  | { kind: "badge"; text: string; cls: string };

/**
 * Order matters. A row waiting on the rep asks first; then the two reasons a
 * line is held, which outrank what the matcher thought; then whether a human
 * has settled it; and only then the matcher's own verdict.
 */
export function reviewRowBadge(r: RowState): RowBadge {
  const label = STATUS_LABEL[r.status];
  if (r.chosen && !r.confirmed) return { kind: "confirm" };
  if (r.pending) return { kind: "badge", text: PENDING_BADGE, cls: "amber" };
  if (r.held) return { kind: "badge", text: "Ditahan", cls: "amber" };
  // Nothing matched and the rep has not decided: the adjustment is still owed.
  if (!r.chosen && r.status === "none" && !r.confirmed) return { kind: "badge", ...label };
  // Left out on purpose — a different thing from "nothing matched".
  if (!r.chosen) return { kind: "badge", text: "Tidak dipakai", cls: "grey" };
  // The matcher was unsure either way ("review") or had nothing ("none"); a
  // person settled it, so the row is done and says so.
  if (r.status === "review" || r.status === "none") return { kind: "badge", text: "Sudah dicek", cls: "green" };
  return { kind: "badge", ...label };
}
