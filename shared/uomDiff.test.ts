import { describe, expect, it } from "vitest";
import type { ReceiptLine } from "./lastPurchaseCost";
import type { CatalogFacts, SalesLine } from "./salesBelowCost";
import { findUomDiff } from "./uomDiff";

const sale = (o: Partial<SalesLine> = {}): SalesLine => ({
  invoiceNo: "SI.1", transDate: "2026-10-26", customerName: "MESTIKA", itemCode: "100003", unit: "BOX",
  unitRatio: 24, quantity: 2, returnQty: 0, salesAmount: 300_000, inclusiveTax: false, taxRate: 11, cashDiscount: 0, subTotal: 300_000, ...o,
});
const catalog = new Map<string, CatalogFacts>([
  ["100003", { name: "Spiva 500ML", uom: "BTL", listPrice: 8_000, baseUom: "BTL", units: [{ uom: "BOX", factor: 24 }] }],
]);
const ri = (receiptNo: string, transDate: string, unit: string, receiptId = 1): ReceiptLine =>
  ({ receiptId, lineId: 1, receiptNo, transDate, unit, quantity: 10, unitPrice: 6_000 });
const pis = (...r: ReceiptLine[]) => new Map([["100003", r]]);

describe("findUomDiff", () => {
  it("flags an SI unit that differs from the PI's, with both ratios", () => {
    expect(findUomDiff([sale()], pis(ri("PI.1", "2026-10-01", "BTL")), catalog)).toEqual([
      expect.objectContaining({ invoiceNo: "SI.1", siUnit: "BOX", siRatio: 24, piUnit: "BTL", piRatio: 1, receiptNo: "PI.1" }),
    ]);
  });

  it("skips the same unit, ignoring case and spaces like the rest of the app", () => {
    expect(findUomDiff([sale({ unit: "box " })], pis(ri("PI.1", "2026-10-01", "BOX")), catalog)).toEqual([]);
  });

  it("uses the PI that Jual < Beli uses: the last one on or before the SI date", () => {
    const r = pis(ri("PI.old", "2026-09-01", "BOX", 1), ri("PI.last", "2026-10-20", "BTL", 2), ri("PI.later", "2026-11-01", "BOX", 3));
    expect(findUomDiff([sale()], r, catalog).map((x) => x.receiptNo)).toEqual(["PI.last"]);
  });

  it("an unknown ratio on either side is null and sorts first", () => {
    const rows = findUomDiff(
      [sale({ invoiceNo: "SI.ok", transDate: "2026-10-27" }), sale({ invoiceNo: "SI.dus", unit: "DUS", unitRatio: 1 })],
      pis(ri("PI.1", "2026-10-01", "BTL")),
      catalog,
    );
    expect(rows.map((x) => [x.invoiceNo, x.siRatio])).toEqual([["SI.dus", null], ["SI.ok", 24]]);
    expect(findUomDiff([sale({ unit: "BTL", unitRatio: 1 })], pis(ri("PI.1", "2026-10-01", "LUSIN")), catalog)[0].piRatio).toBeNull();
  });

  it("no PI before the SI, or no quantity: nothing to compare", () => {
    expect(findUomDiff([sale()], pis(ri("PI.1", "2026-11-01", "BTL")), catalog)).toEqual([]);
    expect(findUomDiff([sale({ quantity: 0 })], pis(ri("PI.1", "2026-10-01", "BTL")), catalog)).toEqual([]);
  });
});
