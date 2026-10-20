import { describe, expect, it } from "vitest";
import { lastPurchaseCost, purchaseCostHold, type ReceiptLine } from "./lastPurchaseCost";

const line = (over: Partial<ReceiptLine>): ReceiptLine => ({
  receiptId: 1,
  lineId: 1,
  receiptNo: "RI.1",
  transDate: "2026-05-21",
  unit: "Pcs",
  quantity: 1,
  unitPrice: 1000,
  ...over,
});
const pcs = { baseUom: "Pcs", units: [] };

describe("lastPurchaseCost", () => {
  it("takes the latest receipt, not the average (101311 keset, Mutasi 21-22 Mei 2026)", () => {
    const lines = [
      line({ receiptId: 501, receiptNo: "RI.2026.05.00021", transDate: "2026-05-21", unitPrice: 10_657_600 }),
      line({ receiptId: 502, receiptNo: "RI.2026.05.00022", transDate: "2026-05-22", unitPrice: 11_005_000 }),
    ];
    expect(lastPurchaseCost(lines, pcs, "Pcs")).toEqual({
      ok: true,
      cost: 11_005_000,
      receiptNo: "RI.2026.05.00022",
      transDate: "2026-05-22",
      unit: "Pcs",
    });
    // Order of the input doesn't matter.
    expect(lastPurchaseCost([...lines].reverse(), pcs, "Pcs")).toMatchObject({ cost: 11_005_000 });
  });

  it("breaks a same-day tie by the later Accurate record (higher id), not the receipt number", () => {
    const lines = [
      line({ receiptId: 900, receiptNo: "RI.A", transDate: "2026-06-01", unitPrice: 2000 }),
      line({ receiptId: 950, receiptNo: "RI.0", transDate: "2026-06-01", unitPrice: 2100 }),
    ];
    expect(lastPurchaseCost(lines, pcs, "Pcs")).toMatchObject({ cost: 2100, receiptNo: "RI.0" });
  });

  it("uses the last line when one receipt holds the item twice", () => {
    const lines = [
      line({ receiptId: 7, lineId: 1, unitPrice: 500 }),
      line({ receiptId: 7, lineId: 2, unitPrice: 550 }),
    ];
    expect(lastPurchaseCost(lines, pcs, "Pcs")).toMatchObject({ cost: 550 });
  });

  it("skips lines without a price or quantity (bonus/sample goods) and falls back to the one before", () => {
    const lines = [
      line({ receiptId: 1, transDate: "2026-05-01", unitPrice: 800 }),
      line({ receiptId: 2, transDate: "2026-05-02", unitPrice: 0 }),
      line({ receiptId: 3, transDate: "2026-05-03", quantity: 0, unitPrice: 900 }),
    ];
    expect(lastPurchaseCost(lines, pcs, "Pcs")).toMatchObject({ cost: 800, transDate: "2026-05-01" });
  });

  it("reports an item that was never received", () => {
    expect(lastPurchaseCost([], pcs, "Pcs")).toEqual({ ok: false, reason: "no_receipt" });
    expect(lastPurchaseCost([line({ unitPrice: 0 })], pcs, "Pcs")).toEqual({ ok: false, reason: "no_receipt" });
  });

  it("converts a receipt in a larger unit to the base unit", () => {
    const units = { baseUom: "Pcs", units: [{ uom: "Box", factor: 12 }] };
    expect(lastPurchaseCost([line({ unit: "box", unitPrice: 120_000 })], units, "pcs")).toMatchObject({
      ok: true,
      cost: 10_000,
      unit: "box",
    });
    // A ratio that doesn't divide evenly keeps two decimals, like shared/uom.ts.
    expect(lastPurchaseCost([line({ unit: "Box", unitPrice: 25_000 })], { baseUom: "Pcs", units: [{ uom: "Box", factor: 24 }] }, "Pcs"))
      .toMatchObject({ cost: 1041.67 });
  });

  it("refuses a receipt unit without a known ratio instead of using an older receipt", () => {
    const lines = [
      line({ receiptId: 1, transDate: "2026-05-01", unit: "Pcs", unitPrice: 1000 }),
      line({ receiptId: 2, transDate: "2026-05-02", unit: "Lusin", unitPrice: 13_000 }),
    ];
    expect(lastPurchaseCost(lines, pcs, "Pcs")).toEqual({
      ok: false,
      reason: "unknown_unit",
      receiptNo: "RI.1",
      transDate: "2026-05-02",
      unit: "Lusin",
    });
    expect(lastPurchaseCost([line({ unit: "" })], pcs, "Pcs")).toMatchObject({ ok: false, reason: "unknown_unit" });
  });

  it("refuses when the catalog keeps a different base unit than Accurate (its COGS is per another unit)", () => {
    expect(lastPurchaseCost([line({})], pcs, "Box")).toEqual({ ok: false, reason: "uom_mismatch" });
  });
});

describe("purchaseCostHold (guard for Terapkan, 2026-10-17)", () => {
  it("holds a purchase price 3x the selling price or more, even from an empty COGS (078328 tissue)", () => {
    expect(purchaseCostHold(0, 74_750, 7_500)).toBe("Harga beli Rp 74.750 3x lipat atau lebih dari harga jual katalog Rp 7.500");
    expect(purchaseCostHold(0, 22_500, 7_500)).not.toBeNull();
  });

  it("lets a real cost above a stale selling price through: cogsCheck blocks the quote line instead (101311 keset)", () => {
    expect(purchaseCostHold(10_831_300, 11_005_000, 8_250_000)).toBeNull();
    expect(purchaseCostHold(0, 22_499, 7_500)).toBeNull();
  });

  it("holds more than double or less than half the current COGS (102373 piston, 103026 scrapper)", () => {
    expect(purchaseCostHold(71_000, 2_192_847, 0)).toMatch(/lebih dari dua kali COGS sekarang Rp 71.000/);
    expect(purchaseCostHold(29_029.88, 8_448.33, 0)).toMatch(/kurang dari separuh COGS sekarang/);
  });

  it("lets ordinary changes through, including exactly double, exactly half and at list price", () => {
    expect(purchaseCostHold(10_831_300, 11_005_000, 12_000_000)).toBeNull();
    expect(purchaseCostHold(1000, 2000, 0)).toBeNull();
    expect(purchaseCostHold(1000, 500, 0)).toBeNull();
    expect(purchaseCostHold(1000, 1500, 1500)).toBeNull();
    // A first COGS with no selling price to compare against has nothing to be checked with.
    expect(purchaseCostHold(0, 50_000, 0)).toBeNull();
  });
});
