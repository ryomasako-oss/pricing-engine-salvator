import { describe, expect, it } from "vitest";
import { DEFAULT_ASSUMPTIONS, computeEngine } from "./engine";
import { calibrateS2, quickPrice } from "./quickPrice";
import type { QuoteItem } from "./types";

const a = { ...DEFAULT_ASSUMPTIONS, opex: 0.08, includeLogistics: false, step: 50 };
const line = (over: Partial<QuoteItem>): QuoteItem =>
  ({ id: "x", lineNo: 1, code: "C", name: "Item", uom: "Pcs", qty: 1, cogs: 10000, rrp: 14000, role: "CORE", ...over }) as QuoteItem;
const run = (items: QuoteItem[], base: "cogs" | "plafon", pct: number, scenario: 0 | 1 | 2 = 0) =>
  quickPrice(items, computeEngine(a, items, []).rows, scenario, base, pct, a.step);

describe("quickPrice (tombol cepat, Ryoma 2026-11-04)", () => {
  it("from COGS: a real margin, landed / (1 - m), in the chosen scenario only", () => {
    const r = run([line({ rrpDefault: true })], "cogs", 0.3, 1);
    // landed 10.800 / 0,7 = 15.428,57 -> 15.450, above the default ceiling of 14.000
    expect(r.items[0].manualPrice).toEqual([null, 15450, null]);
    expect(r).toMatchObject({ changed: 1, capped: 0, skipped: 0 });
    const m = computeEngine(a, r.items, []).rows[0].margins[1];
    expect(m).toBeGreaterThanOrEqual(0.3);
  });

  it("from COGS: a client's ceiling caps it and is counted", () => {
    const r = run([line({})], "cogs", 0.3);
    expect(r.items[0].manualPrice).toEqual([14000, null, null]);
    expect(r.capped).toBe(1);
  });

  it("from the ceiling: ceiling x (1 + p), rounded up to the step", () => {
    expect(run([line({ rrp: 10000 })], "plafon", 0.15).items[0].manualPrice).toEqual([11500, null, null]);
    expect(run([line({ rrp: 10010 })], "plafon", 0.1).items[0].manualPrice).toEqual([11050, null, null]);
  });

  it("never more than 30%, keeps other scenarios' manual prices, skips held lines and lines with nothing to start from", () => {
    expect(run([line({ rrp: 10000 })], "plafon", 0.5).items[0].manualPrice).toEqual([13000, null, null]);
    const r = run(
      [
        line({ id: "a", manualPrice: [null, null, 9000] }),
        line({ id: "b", held: true }),
        line({ id: "c", cogs: 0 }),
        line({ id: "d", rrp: 0 }),
      ],
      "plafon",
      0.1,
    );
    expect(r.items[0].manualPrice).toEqual([15400, null, 9000]);
    expect(r.items[1].manualPrice).toBeUndefined();
    expect(r.items[3].manualPrice).toBeUndefined();
    expect(r).toMatchObject({ changed: 2, skipped: 2 });
  });
});

describe("calibrateS2 (overall margin in S2)", () => {
  it("brings the S2 net margin to the target: client-capped lines stay at their ceiling, the others make up for it, LEADER keeps its price", () => {
    const items = [
      line({ id: "cap", cogs: 33784, rrp: 37838, qty: 5 }), // client ceiling: 3,6% at most
      line({ id: "d1", cogs: 10000, rrp: 14000, qty: 18, rrpDefault: true }),
      line({ id: "d2", cogs: 5508, rrp: 7712, qty: 18, rrpDefault: true }),
      line({ id: "lead", cogs: 2000, rrp: 3000, qty: 10, role: "LEADER" }),
    ];
    const r = calibrateS2(items, a, [], 0.3);
    expect(r.reached).toBe(true);
    expect(r.achieved).toBeGreaterThanOrEqual(0.3);
    expect(r.achieved).toBeLessThan(0.32); // the smallest margin that gets there, not the maximum
    expect(r.items[0].manualPrice?.[1]).toBe(37838);
    expect(r.items[3].manualPrice).toBeUndefined();
    expect(r.margin).toBeGreaterThan(0.3); // the uncapped lines carry more than 30%
    expect(r.items[1].manualPrice?.[0]).toBeNull(); // S1 untouched
  });

  it("reports how far it got when the target can't be reached", () => {
    const r = calibrateS2([line({ cogs: 10000, rrp: 11000 })], a, [], 0.3);
    expect(r.reached).toBe(false);
    expect(r.achieved).toBeLessThan(0.3);
  });
});
