import { describe, expect, it } from "vitest";
import { DEFAULT_ASSUMPTIONS, computeEngine } from "./engine";
import { quickPrice } from "./quickPrice";
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
