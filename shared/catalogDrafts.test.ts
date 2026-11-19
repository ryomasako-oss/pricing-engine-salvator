import { describe, expect, it } from "vitest";
import { draftChanges } from "./catalogDrafts.js";

describe("draftChanges", () => {
  it("names a barcode set, a generated one and a removal", () => {
    expect(draftChanges("barcode", "Box", { barcode: "899" }, { barcode: null })).toEqual(["Barcode Box: kosong → 899"]);
    expect(draftChanges("barcode", "Pcs", { generate: true }, { barcode: null })).toEqual(["Barcode Pcs: kosong → buatkan barcode otomatis"]);
    expect(draftChanges("barcode", "Pcs", { barcode: null }, { barcode: "123" })).toEqual(["Barcode Pcs: 123 → dihapus"]);
  });

  it("writes a new unit as its ratio, smaller units the other way round", () => {
    expect(draftChanges("unit", "Box", { factor: 24, base: "Pcs", barcode: "777" }, {})).toEqual(["Satuan baru: 1 Box = 24 Pcs, barcode 777"]);
    expect(draftChanges("unit", "Lsn", { factor: 1 / 12, base: "Pcs" }, {})[0]).toBe("Satuan baru: 1 Pcs = 12 Lsn");
  });

  it("lists only the fields of an edit that changed", () => {
    const before = { name: "Pulpen", uom: "Pcs", category: "", units: [{ uom: "Box", factor: 10 }] };
    expect(draftChanges("edit", "", { ...before, units: [{ uom: "Box", factor: 12 }] }, before)).toEqual([
      "Satuan tambahan: 1 Box = 10 Pcs → 1 Box = 12 Pcs",
    ]);
    expect(draftChanges("edit", "", { ...before, name: "Pulpen Biru" }, before)).toEqual(["Nama: Pulpen → Pulpen Biru"]);
    expect(draftChanges("edit", "", before, before)).toEqual(["Tidak ada yang berubah"]);
  });
});
