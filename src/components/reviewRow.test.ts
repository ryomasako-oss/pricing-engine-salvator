import { describe, expect, it } from "vitest";
import { STATUS_LABEL, reviewRowBadge, type RowState } from "./reviewRow";

const row = (over: Partial<RowState> = {}): RowState => ({
  status: "match",
  chosen: true,
  confirmed: true,
  pending: false,
  held: false,
  ...over,
});
const badge = (over: Partial<RowState> = {}) => {
  const b = reviewRowBadge(row(over));
  return b.kind === "badge" ? `${b.text}/${b.cls}` : b.kind;
};

describe("reviewRowBadge", () => {
  it("asks the rep to accept a suggestion before showing any badge", () => {
    expect(badge({ confirmed: false })).toBe("confirm");
    expect(badge({ status: "review", confirmed: false })).toBe("confirm");
    // Even a held item waits for the acceptance first.
    expect(badge({ confirmed: false, held: true })).toBe("confirm");
  });

  it("a row the matcher could not resolve owes an adjustment", () => {
    expect(badge({ status: "none", chosen: false, confirmed: false })).toBe("Adjustment/blue");
  });

  it("clears to 'Sudah dicek' once a person settles it — the bug this file exists for", () => {
    // Was "Adjustment" forever: the rep had picked an item and the row still read unresolved.
    expect(badge({ status: "none" })).toBe("Sudah dicek/green");
    // "review" already behaved; it must keep behaving.
    expect(badge({ status: "review" })).toBe("Sudah dicek/green");
  });

  it("tells a dropped row apart from an unmatched one", () => {
    // The rep explicitly chose "— tidak dipakai —" on a row that had nothing.
    expect(badge({ status: "none", chosen: false, confirmed: true })).toBe("Tidak dipakai/grey");
    // And on a row that did have a candidate.
    expect(badge({ status: "review", chosen: false, confirmed: true })).toBe("Tidak dipakai/grey");
  });

  it("a held line says what it waits for, whatever the matcher thought", () => {
    expect(badge({ pending: true })).toBe("Menunggu Accurate/amber");
    expect(badge({ status: "none", pending: true })).toBe("Menunggu Accurate/amber");
    expect(badge({ held: true })).toBe("Ditahan/amber");
    // "Barang baru" outranks a COGS hold: it is the more specific reason.
    expect(badge({ pending: true, held: true })).toBe("Menunggu Accurate/amber");
  });

  it("keeps the matcher's own verdict when it was sure", () => {
    expect(badge({ status: "exact" })).toBe("Pasti/green");
    expect(badge({ status: "match" })).toBe("Cocok/green");
  });

  it("every status has a label, and only 'none' is the actionable blue", () => {
    expect(Object.keys(STATUS_LABEL).sort()).toEqual(["exact", "match", "none", "review"]);
    expect(Object.values(STATUS_LABEL).filter((l) => l.cls === "blue")).toEqual([STATUS_LABEL.none]);
    expect(STATUS_LABEL.none.text).toBe("Adjustment");
  });
});
