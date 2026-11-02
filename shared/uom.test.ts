import { describe, expect, it } from "vitest";
import { amountInUnit, changeLineUom, cleanUnits, toBaseUnit, uomChoices, uomWarning, unitFactor, type ItemUnits, packUnitNeedsCheck, packUnitWord, readPackUnit } from "./uom.js";
import type { QuoteItem } from "./types.js";

const line = (over: Partial<QuoteItem> = {}): QuoteItem => ({
  id: "l1",
  lineNo: 1,
  code: "ATK-001",
  name: "Pulpen Hitam",
  uom: "Pcs",
  qty: 10,
  cogs: 1000,
  rrp: 1500,
  role: "CORE",
  ...over,
});

const PEN: ItemUnits = { baseUom: "Pcs", units: [{ uom: "Lusin", factor: 12 }, { uom: "Box", factor: 24 }] };

describe("unitFactor", () => {
  it("is 1 for the base unit and the ratio for extra units, case-insensitively", () => {
    expect(unitFactor(PEN, "pcs")).toBe(1);
    expect(unitFactor(PEN, "BOX")).toBe(24);
    expect(unitFactor(PEN, " lusin ")).toBe(12);
  });

  it("is undefined for an unknown unit, no item data, or a non-positive ratio", () => {
    expect(unitFactor(PEN, "Rim")).toBeUndefined();
    expect(unitFactor(undefined, "Pcs")).toBeUndefined();
    expect(unitFactor({ baseUom: "Pcs", units: [{ uom: "Box", factor: 0 }] }, "Box")).toBeUndefined();
  });
});

describe("changeLineUom keeps the recorded catalog COGS in the line's unit", () => {
  it("rescales catalogCogs with cogs", () => {
    const units = { baseUom: "Pcs", units: [{ uom: "Box", factor: 12 }] };
    const line = { id: "x", lineNo: 1, code: "P", name: "P", uom: "Pcs", qty: 1, cogs: 100, catalogCogs: 100, rrp: 150, role: "CORE" as const };
    expect(changeLineUom(line, "Box", units)).toMatchObject({ cogs: 1200, catalogCogs: 1200 });
  });
});

describe("changeLineUom", () => {
  it("scales COGS, RRP and manual prices from base to a bigger unit", () => {
    const out = changeLineUom(line({ manualPrice: [null, 1200, null] }), "Box", PEN);
    expect(out).toMatchObject({ uom: "Box", cogs: 24000, rrp: 36000, manualPrice: [null, 28800, null] });
    expect(out.priceUom).toBeUndefined();
  });

  it("converts between two non-base units via the base", () => {
    const out = changeLineUom(line({ uom: "Lusin", cogs: 12000, rrp: 18000 }), "Box", PEN);
    expect(out).toMatchObject({ uom: "Box", cogs: 24000, rrp: 36000 });
  });

  it("keeps qty unchanged (the rep sets qty in the new unit)", () => {
    expect(changeLineUom(line({ qty: 7 }), "Box", PEN).qty).toBe(7);
  });

  it("round-trips back to the exact starting values", () => {
    const start = line({ cogs: 1234, rrp: 1999, manualPrice: [1500, null, 1800] });
    const back = changeLineUom(changeLineUom(changeLineUom(start, "Lusin", PEN), "Box", PEN), "Pcs", PEN);
    expect(back).toMatchObject({ uom: "Pcs", cogs: 1234, rrp: 1999, manualPrice: [1500, null, 1800] });
  });

  it("stays within Rp 1 on a round trip whose ratio doesn't divide evenly", () => {
    const box = line({ uom: "Box", cogs: 25000, rrp: 31000 });
    const pcs = changeLineUom(box, "Pcs", PEN);
    expect(pcs.cogs).toBe(1041.67);
    const again = changeLineUom(pcs, "Box", PEN);
    expect(Math.abs(again.cogs - 25000)).toBeLessThan(1);
    expect(Math.abs(again.rrp - 31000)).toBeLessThan(1);
  });

  it("changes only the label and records priceUom when the new unit has no ratio", () => {
    const out = changeLineUom(line(), "Rim", PEN);
    expect(out).toMatchObject({ uom: "Rim", cogs: 1000, rrp: 1500, priceUom: "Pcs" });
    expect(uomWarning(out)).toContain("Rasio Rim belum ada");
    expect(uomWarning(out)).toContain("per Pcs");
  });

  it("converts from priceUom, not the shown label, after an unconverted switch", () => {
    const stuck = changeLineUom(line(), "Rim", PEN);
    const out = changeLineUom(stuck, "Box", PEN);
    expect(out).toMatchObject({ uom: "Box", cogs: 24000, rrp: 36000 });
    expect(out.priceUom).toBeUndefined();
    expect(uomWarning(out)).toBeNull();
  });

  it("clears the warning when switching back to the unit the numbers are in", () => {
    const out = changeLineUom(changeLineUom(line(), "Rim", PEN), "pcs", PEN);
    expect(out).toMatchObject({ uom: "pcs", cogs: 1000 });
    expect(out.priceUom).toBeUndefined();
  });

  it("treats a line without catalog data (manual or legacy) as unconvertible, with a warning", () => {
    const out = changeLineUom(line({ code: "" }), "Box", undefined);
    expect(out).toMatchObject({ uom: "Box", cogs: 1000, priceUom: "Pcs" });
  });

  it("leaves a line without manual prices without a manualPrice field", () => {
    expect(changeLineUom(line(), "Box", PEN).manualPrice).toBeUndefined();
  });
});

describe("amountInUnit", () => {
  const pen = { baseUom: "Pcs", units: [{ uom: "Box", factor: 12 }] };
  it("re-expresses a per-unit amount in another unit with the item's ratio", () => {
    expect(amountInUnit(pen, "Pcs", "Box", 200)).toBe(2400);
    expect(amountInUnit(pen, "box", "pcs", 5000)).toBe(416.67);
    expect(amountInUnit(pen, "Box", "Box", 5000)).toBe(5000);
  });
  it("is null when a unit has no known ratio", () => {
    expect(amountInUnit(pen, "Pcs", "Lusin", 200)).toBeNull();
    expect(amountInUnit(undefined, "Pcs", "Box", 200)).toBeNull();
  });
});

describe("toBaseUnit", () => {
  it("converts a line's prices back to per-base-unit", () => {
    expect(toBaseUnit(line({ uom: "Box", cogs: 24000, rrp: 36000 }), PEN)).toEqual({ cogs: 1000, rrp: 1500 });
  });

  it("uses priceUom when the label couldn't be converted", () => {
    const stuck = changeLineUom(line({ uom: "Box", cogs: 24000, rrp: 36000 }), "Rim", PEN);
    expect(toBaseUnit(stuck, PEN)).toEqual({ cogs: 1000, rrp: 1500 });
  });

  it("is null when the line's price unit has no ratio", () => {
    expect(toBaseUnit(line({ uom: "Rim" }), PEN)).toBeNull();
  });
});

describe("cleanUnits", () => {
  it("drops the base unit, blanks, bad ratios and case-insensitive duplicates", () => {
    expect(
      cleanUnits("Pcs", [
        { uom: "PCS", factor: 1 },
        { uom: " Box ", factor: 24 },
        { uom: "box", factor: 12 },
        { uom: "", factor: 5 },
        { uom: "Pak", factor: 0 },
        { uom: "Lusin", factor: 12 },
      ]),
    ).toEqual([{ uom: "Box", factor: 24 }, { uom: "Lusin", factor: 12 }]);
  });
});

describe("uomChoices", () => {
  it("puts the item's own units first, then the managed list, de-duplicated case-insensitively", () => {
    const item: ItemUnits = { baseUom: "BTL", units: [{ uom: "BOX", factor: 24 }] };
    expect(uomChoices(["Box", "Pcs"], item, "BTL")).toEqual(["BTL", "BOX", "Pcs"]);
  });

  it("uses the line's own spelling when the item's unit differs only in case", () => {
    const item: ItemUnits = { baseUom: "PCS", units: [{ uom: "BOX", factor: 24 }] };
    expect(uomChoices(["Pcs", "Box"], item, "Pcs")).toEqual(["Pcs", "BOX"]);
  });

  it("keeps the line's current unit even when nothing else lists it", () => {
    expect(uomChoices(["Pcs"], undefined, "Karung")).toEqual(["Pcs", "Karung"]);
  });
});

describe("unit written in a client's wording (PO PT Primajaya)", () => {
  const artline = { uom: "PCS", units: [{ uom: "CRT", factor: 576 }, { uom: "LSN", factor: 12 }] };
  const binderGross = { uom: "LSN", units: [{ uom: "GRS", factor: 12 }] };
  const glue = { uom: "PCS", units: [] };

  it("finds the pack unit in the usual PO phrasings", () => {
    expect(packUnitWord("Artline Highlighter EK-660 Hijau ( isi 12/Lusin )")).toBe("lusin");
    expect(packUnitWord("Joyko Glue Stick GS-25 isi 25 gram ( isi 12/lusin)")).toBe("lusin");
    expect(packUnitWord("Binder Clip Joyko No. 105 (1 Gross @12 Pack)")).toBe("gross");
    expect(packUnitWord("Binder Clip Joyko No.300 (1 bOX @6 PCS)")).toBe("box");
    expect(packUnitWord("Klip Trigonal Joyko No. 5 ( ISI 10 KOTAK/BOX )")).toBe("box");
    // Nothing about a pack: nothing to read.
    expect(packUnitWord("Pena Oval Joyko Gel 0,5 mm Biru")).toBeUndefined();
    expect(packUnitWord("Kertas A4 70gr (Besar)")).toBeUndefined();
    expect(packUnitWord("3 in 1 pelumas isi 100ml")).toBeUndefined();
  });

  it("returns the item's own spelling, only for a unit the item really has", () => {
    expect(readPackUnit("Artline EK-660 Hijau (isi 12/Lusin)", artline)).toEqual({ uom: "LSN" });
    expect(readPackUnit("Binder Clip No. 155 (1 Gross @12 Pack)", binderGross)).toEqual({ uom: "GRS" });
    // The base unit counts: no conversion needed.
    expect(readPackUnit("Binder Clip No.300 (1 box @6 PCS)", { uom: "KTK", units: [] })).toEqual({ uom: "KTK" });
  });

  it("a lusin whose count in the wording differs from the catalog's ratio is a conflict, not a conversion", () => {
    expect(readPackUnit("Artline (isi 12/Lusin)", { uom: "PCS", units: [{ uom: "LSN", factor: 6 }] })).toEqual({ conflict: { word: "lusin", text: 12, catalog: 6 } });
    // No count written: the catalog's ratio is taken as it is.
    expect(readPackUnit("Pena (1 Lusin @12 Pcs)", { uom: "PCS", units: [{ uom: "LSN", factor: 12 }] })).toEqual({ uom: "LSN" });
  });

  it("says so when a lusin or gross is written but the item has no such unit", () => {
    expect(readPackUnit("Joyko Glue Stick GS-25 (isi 12/lusin)", glue)).toEqual({ unmatched: "lusin" });
    // A box that does not fit is not worth a warning (a box of 12 is a lusin).
    expect(readPackUnit("Binder Clip No.260 (1 box @12 PCS)", { uom: "LSN", units: [] })).toEqual({});
  });
});

describe("which lines need a person to check the unit", () => {
  const artline = { uom: "PCS", units: [{ uom: "LSN", factor: 12 }] };
  it("a converted unit, a missing lusin/gross and a count conflict need a check", () => {
    expect(packUnitNeedsCheck("Artline EK-660 (isi 12/Lusin)", artline)).toBe(true);
    expect(packUnitNeedsCheck("Glue Stick GS-25 (isi 12/lusin)", { uom: "PCS", units: [] })).toBe(true);
    expect(packUnitNeedsCheck("Artline (isi 12/Lusin)", { uom: "PCS", units: [{ uom: "LSN", factor: 6 }] })).toBe(true);
  });
  it("nothing written, or the base unit already is the unit, needs none", () => {
    expect(packUnitNeedsCheck("Pena Oval Joyko Gel 0,5 mm Biru", artline)).toBe(false);
    expect(packUnitNeedsCheck("Binder Clip No.300 (1 box @6 PCS)", { uom: "KTK", units: [] })).toBe(false);
    expect(packUnitNeedsCheck("Binder Clip No.260 (1 box @12 PCS)", { uom: "LSN", units: [] })).toBe(false);
  });
});

