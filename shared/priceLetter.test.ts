import { describe, expect, it } from "vitest";
import { letterLines, newPriceRefusal, netMargin } from "./priceLetter";
import { DEFAULT_POLICY, evaluatePolicy } from "./policy";
import { computeEngine, DEFAULT_ASSUMPTIONS } from "./engine";
import type { BelowCostRow } from "./salesBelowCost";
import type { Hint } from "./belowCostHints";

const rule = { minNetMargin: 0.15, opex: 0.08, step: 50 };
const row = (o: Partial<BelowCostRow> & { unit?: string; unitRatio?: number; lineAmount?: number }): BelowCostRow => ({
  invoiceNo: "SI.1", transDate: "2026-11-01", customerName: "PT A", code: "A-1", name: "Map plastik",
  net: 800, cost: 1000, receiptNo: "PI.1", lossTotal: 2400, avgNet: 800, hints: [],
  trace: {
    unit: o.unit ?? "Lusin", quantity: 1, returnQty: 0, unitRatio: o.unitRatio ?? 12, baseUom: "Pcs", detailName: "", discount: 0,
    receiptDate: "2026-10-01", receiptUnit: "Pcs", inclusiveTax: false, taxRate: 11, lineAmount: o.lineAmount ?? 9600,
  },
  ...o,
});
const hint = (kind: Hint["kind"]): Hint[] => [{ kind, label: kind, detail: "" }];

describe("surat perubahan harga", () => {
  it("priced in the client's unit, one line per item, loss summed", () => {
    const [l, ...rest] = letterLines([row({}), row({ lossTotal: 100, unit: "Pcs", unitRatio: 1, lineAmount: 800 })], rule);
    expect(rest).toEqual([]);
    expect(l).toMatchObject({ unit: "Lusin", ratio: 12, oldPrice: 9600, cost: 12000, lossTotal: 2500, group: "none" });
    // 12.000 x 1,08 / 0,85 = 15.247 -> up to the next 50.
    expect(l.suggested).toBe(15250);
    expect(l.marginNow).toBeCloseTo((9600 - 12960) / 9600);
  });

  it("only real losses: data slips, non-sales and covered bonuses are left out", () => {
    const rows = [
      row({ code: "D", hints: hint("ppn") }),
      row({ code: "O", hints: hint("generic") }),
      row({ code: "B", hints: hint("bonus_ok") }),
      row({ code: "P", hints: hint("bonus_loss"), lineAmount: 0, avgNet: 0 }),
      row({ code: "N" }),
    ];
    expect(letterLines(rows, rule).map((l) => [l.code, l.group])).toEqual([["P", "pricing"], ["N", "none"]]);
  });

  it("a free line with no paid one: old price 0, in the free line's unit", () => {
    const [l] = letterLines([row({ hints: hint("bonus_loss"), lineAmount: 0, avgNet: 0, unit: "Pcs", unitRatio: 1 })], rule);
    expect(l).toMatchObject({ unit: "Pcs", oldPrice: 0, cost: 1000, marginNow: -1 });
  });

  it("a quote at the suggested price passes the margin policy", () => {
    for (const cost of [1000, 12000, 7333, 455_000]) {
      const [l] = letterLines([row({ cost, unitRatio: 1, unit: "Pcs" })], rule);
      expect(netMargin(l.suggested, l.cost, rule.opex)).toBeGreaterThanOrEqual(rule.minNetMargin);
      const engine = computeEngine(
        { ...DEFAULT_ASSUMPTIONS, opex: rule.opex, step: rule.step },
        [{ id: "1", lineNo: 1, code: "A-1", name: "x", uom: "Pcs", qty: 1, cogs: l.cost, rrp: l.suggested, role: "CORE", manualPrice: [l.suggested, l.suggested, l.suggested] }],
        [],
      );
      expect(engine.scen[0].revenue).toBe(l.suggested);
      const breaches = evaluatePolicy(engine, 0, { ...DEFAULT_POLICY, minNetMargin: rule.minNetMargin });
      expect(breaches.filter((b) => b.code === "NET_MARGIN")).toEqual([]);
    }
  });

  it("refuses a new price that still loses", () => {
    expect(newPriceRefusal({ cost: 1000, name: "X" }, 1000)).toContain("tetap rugi");
    expect(newPriceRefusal({ cost: 1000, name: "X" }, 1000.5)).toContain("bulat");
    expect(newPriceRefusal({ cost: 1000, name: "X" }, 1001)).toBeNull();
  });
});
