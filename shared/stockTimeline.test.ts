import { describe, expect, it } from "vitest";
import { buildTimeline, type TimelineMutation } from "./stockTimeline";

const m = (id: number, created: string, qty: number, extra: Partial<TimelineMutation> = {}): TimelineMutation => ({
  id, type: "DO", number: `DO.${id}`, trans_date: created.slice(0, 10), created_wib: created, qty, removed: false, ...extra,
});

describe("buildTimeline", () => {
  it("walks back from Accurate's current stock and flags the first step into minus and a backdated entry", () => {
    // Stok Accurate sekarang -5. Mundur: 12 → (-10) 2 → (-7, dibuat 18 Nov bertanggal 17 Nov) -5 → (0) -5.
    const ev = buildTimeline(-5, "2026-11-20 08:00:00", [
      m(1, "2026-11-17 09:00:00", -10),
      m(2, "2026-11-18 07:52:05", -7, { trans_date: "2026-11-17" }),
      m(3, "2026-11-19 10:00:00", 0.0),
    ], []);
    const muts = ev.filter((e) => e.kind === "mutation") as Extract<typeof ev[number], { kind: "mutation" }>[];
    expect(muts.map((e) => [e.m.id, e.balance, e.wentNegative, e.backdated])).toEqual([
      [3, -5, false, false],
      [2, -5, true, true],
      [1, 2, false, false],
    ]);
  });

  it("a count older than the stored history has no known balance", () => {
    const ev = buildTimeline(10, null, [m(1, "2026-11-19 09:00:00", -4)], [{ id: 9, counted: 8, accurate_qty: null, counted_wib: "2026-11-01 10:00:00", status: "open", counted_by_name: null }]);
    expect(ev.find((e) => e.kind === "count")).toMatchObject({ balance: null, gap: null });
  });

  it("counts after the anchor forward, ignores removed rows, and places a count against the balance at that moment", () => {
    const ev = buildTimeline(10, "2026-11-20 08:00:00", [
      m(1, "2026-11-19 09:00:00", -4),
      m(2, "2026-11-19 12:00:00", -3, { removed: true }),
      m(3, "2026-11-21 09:00:00", +6),
    ], [{ id: 9, counted: 8, accurate_qty: 10, counted_wib: "2026-11-20 10:00:00", status: "open", counted_by_name: "g" }]);
    expect(ev.map((e) => (e.kind === "mutation" ? `m${e.m.id}:${e.balance}` : `c${e.c.id}:${e.balance}:${e.gap}`))).toEqual([
      "m3:16", "c9:10:-2", "m1:10",
    ]);
  });
});
