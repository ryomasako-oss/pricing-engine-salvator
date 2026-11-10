import { describe, expect, it } from "vitest";
import { belowCostHints, looksLikeSlip } from "./belowCostHints";

const base = { net: 8000, cost: 10000, saleDate: "2026-10-05", receiptDate: "2026-10-01", listPrice: 15000, saleUnit: "Pcs", saleRatio: 1, baseUom: "Pcs" };
const kinds = (r: Partial<typeof base>) => belowCostHints({ ...base, ...r }).map((h) => h.kind);

describe("belowCostHints", () => {
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
