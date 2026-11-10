import { describe, expect, it } from "vitest";
import type { ReceiptLine } from "./lastPurchaseCost";
import { findBelowCost, netPerBaseUnit, type CatalogFacts, type SalesLine } from "./salesBelowCost";

/** SI.2026.10.00297 (4 Nov probe): 16 BOX of 24 BTL at 156.500, exclusive of PPN. */
const spiva: SalesLine = {
  invoiceNo: "SI.2026.10.00297", transDate: "2026-10-26", customerName: "MESTIKA", itemCode: "100003", unit: "BOX",
  unitRatio: 24, quantity: 16, returnQty: 0, salesAmount: 2_504_000, inclusiveTax: false, taxRate: 11, cashDiscount: 0, subTotal: 2_504_000,
};
const catalog = new Map<string, CatalogFacts>([
  ["100003", { name: "Spiva Mineral Water 500ML", uom: "BTL", listPrice: 8_000, baseUom: "BTL", units: [{ uom: "BOX", factor: 24 }] }],
]);
const ri = (receiptNo: string, transDate: string, unitPrice: number, unit = "BTL", receiptId = 1): ReceiptLine =>
  ({ receiptId, lineId: 1, receiptNo, transDate, unit, quantity: 10, unitPrice });

describe("netPerBaseUnit", () => {
  it("divides by the base quantity: 2.504.000 / (16 x 24)", () => {
    expect(netPerBaseUnit(spiva)).toBeCloseTo(6520.83, 2);
  });

  it("an inclusive invoice's salesAmount is already before PPN: not divided again", () => {
    // SI.2025.11.00014 line 101460, as synced on 4 Nov: 4 PCS at 60.000 incl. 11% PPN.
    const l = { ...spiva, unitRatio: 1, quantity: 4, salesAmount: 216_216.432432, inclusiveTax: true, subTotal: 2_757_000 };
    expect(netPerBaseUnit(l)).toBeCloseTo(54_054.11, 2); // 60.000 / 1,11
  });

  it("spreads the invoice discount over the lines", () => {
    // A 10% invoice discount on 100.000 for 10 PCS leaves 9.000 each.
    const l = { ...spiva, unitRatio: 1, quantity: 10, salesAmount: 100_000, cashDiscount: 10_000, subTotal: 100_000 };
    expect(netPerBaseUnit(l)).toBeCloseTo(9000, 6);
  });

  it("is null for a line that sold nothing or was returned in full", () => {
    expect(netPerBaseUnit({ ...spiva, quantity: 0 })).toBeNull();
    expect(netPerBaseUnit({ ...spiva, returnQty: 16 })).toBeNull();
  });
});

describe("findBelowCost", () => {
  it("compares with the purchase price on the invoice date, not a later one", () => {
    const receipts = new Map([["100003", [ri("RI.A", "2026-10-01", 6_000, "BTL", 1), ri("RI.B", "2026-10-30", 7_000, "BTL", 2)]]]);
    // 6.520,83 against 6.000 (RI.A, before the invoice): not a loss, though RI.B (after) is 7.000.
    expect(findBelowCost([spiva], receipts, catalog)).toEqual({ checked: 1, below: [], unknownCost: 0, doubtfulCost: 0 });
  });

  it("reports a line under that day's cost with the loss over the units sold, net of returns", () => {
    const receipts = new Map([["100003", [ri("RI.A", "2026-10-20", 168_000, "BOX")]]]); // 7.000 per BTL
    const r = findBelowCost([{ ...spiva, returnQty: 6 }], receipts, catalog);
    expect(r.below).toEqual([{
      invoiceNo: "SI.2026.10.00297", transDate: "2026-10-26", customerName: "MESTIKA", code: "100003",
      name: "Spiva Mineral Water 500ML", net: 6520.83, cost: 7000, receiptNo: "RI.A", lossTotal: Math.round((7000 - 2_504_000 / 384) * 240), hints: expect.any(Array), trace: expect.objectContaining({ receiptUnit: "BOX" }),
    }]);
  });

  it("a line with no receipt before it has an unknown cost, not a loss", () => {
    const receipts = new Map([["100003", [ri("RI.LATER", "2026-11-01", 9_000)]]]);
    expect(findBelowCost([spiva], receipts, catalog)).toMatchObject({ checked: 0, below: [], unknownCost: 1 });
  });

  it("a receipt cost 3x the selling price or more is doubtful (pack as 1 PCS), not a loss", () => {
    const receipts = new Map([["100003", [ri("RI.PACK", "2026-10-20", 24_000)]]]);
    expect(findBelowCost([spiva], receipts, catalog)).toMatchObject({ checked: 0, below: [], doubtfulCost: 1 });
  });

  it("lists the biggest loss first", () => {
    const receipts = new Map([["100003", [ri("RI.A", "2026-10-20", 7_000)]]]);
    const small = { ...spiva, invoiceNo: "SI.SMALL", quantity: 1, salesAmount: 156_500 };
    expect(findBelowCost([small, spiva], receipts, catalog).below.map((b) => b.invoiceNo)).toEqual(["SI.2026.10.00297", "SI.SMALL"]);
  });
});
