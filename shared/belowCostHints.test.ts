import { describe, expect, it } from "vitest";
import { belowCostHints, looksLikeSlip, matchesCause } from "./belowCostHints";

const base = { net: 8000, cost: 10000, saleDate: "2026-10-05", receiptDate: "2026-10-01", listPrice: 15000, saleUnit: "Pcs", saleRatio: 1, baseUom: "Pcs" };
const kinds = (r: Partial<Parameters<typeof belowCostHints>[0]>) => belowCostHints({ ...base, ...r }).map((h) => h.kind);

describe("belowCostHints", () => {
  it("salah input: far from the item's other PIs or SIs", () => {
    expect(belowCostHints({ ...base, cost: 20000, otherCosts: [10000, 10500] })[0].label).toBe("Cek input harga beli: biasanya ± Rp 10.250");
    expect(kinds({ cost: 20000, otherCosts: [10000] })).toEqual([]); // one other PI is no habit
    expect(kinds({ net: 3000, cost: 10000, otherPrices: [9000, 9500, 9800] })).toEqual(["input_price"]);
    expect(kinds({ net: 1000, cost: 12000, otherCosts: [5000, 5000] })).toEqual(["unit"]); // a pack slip, not input
  });
  it("salah kode: the invoice wording shares no word with the catalog name", () => {
    expect(kinds({ name: "Lakban bening 2 inch", detailName: "LAKBAN BENING 48MM" })).toEqual([]);
    expect(belowCostHints({ ...base, name: "Lakban bening", detailName: "Spidol whiteboard" })[0].kind).toBe("code");
  });
  it("a big invoice discount explains, it is not a slip", () => {
    const h = belowCostHints({ ...base, discount: 0.15 });
    expect(h.map((x) => x.label)).toEqual(["Diskon faktur 15%"]);
    expect(looksLikeSlip(h)).toBe(false);
  });
  it("causes filter the rows the owner asked to tell apart", () => {
    const unit = belowCostHints({ ...base, net: 1000, cost: 12000 });
    expect(matchesCause(unit, "unit")).toBe(true);
    expect(matchesCause(unit, "data")).toBe(true);
    expect(matchesCause(unit, "real")).toBe(false);
    expect(matchesCause(belowCostHints({ ...base, listPrice: 0 }), "real")).toBe(true);
    expect(matchesCause(unit, "")).toBe(true);
  });

  it("a plain loss carries no mark", () => {
    expect(kinds({})).toEqual([]);
    expect(looksLikeSlip(belowCostHints(base))).toBe(false);
  });
  it("cost a pack size times the price: unit slip (1 roll recorded, 1 lusin bought)", () => {
    expect(belowCostHints({ ...base, net: 1000, cost: 12000 })[0].label).toBe("Cek satuan: harga beli ≈ 12× harga jual");
    expect(kinds({ net: 1000, cost: 23500 })).toEqual(["unit"]); // 23,5 ≈ 24 within 8%
    expect(kinds({ net: 1000, cost: 7000 })).toEqual([]); // 7 is no pack size
  });
  it("cost about 11% above the price: PPN slip", () => {
    expect(kinds({ net: 9009, cost: 10000 })).toEqual(["ppn"]);
    expect(kinds({ net: 9500, cost: 10000 })).toEqual([]);
  });
  it("sold in another unit with no ratio", () => {
    expect(kinds({ saleUnit: "BOX", saleRatio: 1 })).toEqual(["sale_unit"]);
    expect(kinds({ saleUnit: "BOX", saleRatio: 10 })).toEqual([]);
    expect(kinds({ saleUnit: "pcs " })).toEqual([]);
  });
  it("stale PI and empty list price", () => {
    expect(kinds({ receiptDate: "2026-03-01" })).toEqual(["old_pi"]);
    const h = belowCostHints({ ...base, listPrice: 0 });
    expect(h.map((x) => x.kind)).toEqual(["no_list"]);
    expect(looksLikeSlip(h)).toBe(false);
  });
});
