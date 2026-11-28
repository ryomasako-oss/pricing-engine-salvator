import { describe, expect, it } from "vitest";
import { isFreeWithoutPaid, letterLines, newPriceRefusal, netMargin } from "./priceLetter";
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
      row({ code: "P", hints: hint("bonus_loss"), lineAmount: 0, avgNet: 600 }),
      row({ code: "F", hints: hint("bonus_loss"), lineAmount: 0, avgNet: 0 }), // free, nothing of it paid: a manager decides
      row({ code: "N" }),
    ];
    expect(letterLines(rows, rule).map((l) => [l.code, l.group])).toEqual([["P", "pricing"], ["N", "none"]]);
  });

  it("a free line with the same item paid: in the free line's unit, at the average", () => {
    const [l] = letterLines([row({ hints: hint("bonus_loss"), lineAmount: 0, avgNet: 600, unit: "Pcs", unitRatio: 1 })], rule);
    expect(l).toMatchObject({ unit: "Pcs", oldPrice: 600, cost: 1000 });
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

describe("surat harga dan barang gratis (Ryoma, 28 Nov)", () => {
  const rule = { minNetMargin: 0.15, opex: 0.08, step: 50 };
  const base = (o: Partial<BelowCostRow> & { lineAmount: number; unit?: string; unitRatio?: number }): BelowCostRow => ({
    invoiceNo: "SI.1", transDate: "2026-11-01", customerName: "PT A", code: "A-1", name: "Barang", net: 0, cost: 1000, receiptNo: "PI.1",
    lossTotal: 1000, avgNet: 0, hints: [{ kind: "bonus_loss", label: "", detail: "" }],
    trace: { unit: o.unit ?? "Pcs", quantity: 1, returnQty: 0, unitRatio: o.unitRatio ?? 1, baseUom: "Pcs", detailName: "", discount: 0,
      receiptDate: "2026-10-01", receiptUnit: "Pcs", inclusiveTax: false, taxRate: 11, lineAmount: o.lineAmount },
    ...o,
  });
  it("a free line with the same item paid: old price is the average, not Rp 0", () => {
    const [l] = letterLines([base({ lineAmount: 0, avgNet: 900 })], rule);
    expect(l).toMatchObject({ oldPrice: 900, cost: 1000 });
  });
  it("a free line with nothing of it paid (an accessory given with another item) stays out of the letter", () => {
    const free = base({ code: "SD", lineAmount: 0, avgNet: 0 });
    expect(isFreeWithoutPaid(free)).toBe(true);
    expect(letterLines([free, base({ code: "B", lineAmount: 8000, net: 8000, avgNet: 8000, cost: 10000, hints: [] })], rule).map((l) => l.code)).toEqual(["B"]);
  });
});
