import { describe, expect, it } from "vitest";
import { lineFromCatalog, matchLines, normalizeText, similarity, tokens } from "./match";
import type { CatalogItem } from "./types";

const item = (id: number, code: string, name: string, over: Partial<CatalogItem> = {}): CatalogItem => ({
  id,
  code,
  name,
  uom: "Pcs",
  cogs: 1000,
  list_price: 1500,
  stock: 0,
  category: "",
  source: "",
  updated_at: "",
  ...over,
});

const CATALOG = [
  item(1, "100036", "STABILO BOSS HIGHLIGHTER ANTI DRY OUT ORANGE"),
  item(2, "100037", "STABILO BOSS HIGHLIGHTER ANTI DRY OUT GREEN"),
  item(3, "K-BD70", "BOLA DUNIA KERTAS A4 70GR"),
  item(4, "K-SD80", "SINAR DUNIA KERTAS A4 80GR"),
  item(5, "778", "FORMULA SIKAT GIGI"),
  item(6, "EK70B", "ARTLINE EK-70 PERMANENT MARKER BLUE"),
  item(7, "EK70LB", "ARTLINE EK-70 PERMANENT MARKER LT. BLUE"),
  item(8, "PST", "STANDARD PULPEN TECNO BLACK 0.38MM"),
];
const none = { client: new Map<string, string>(), global: new Map<string, string>() };

describe("normalizeText / tokens", () => {
  it("glues units to numbers and unifies gram spellings", () => {
    expect(normalizeText("Kertas A4 70 gsm")).toBe("kertas a4 70g");
    expect(normalizeText("Kertas 70gr")).toBe("kertas 70g");
    expect(normalizeText("Tinta 100 ML")).toBe("tinta 100ml");
  });
  it("maps synonyms and drops filler words", () => {
    expect(tokens("Pena warna hitam")).toEqual(["pulpen", "hitam"]);
    expect(tokens("Ballpoint black")).toEqual(["pulpen", "hitam"]);
  });
  it("keeps decimals but not trailing dots", () => {
    expect(tokens("Pulpen 0,5 mm.")).toEqual(["pulpen", "0.5mm"]);
  });
  it("splits a dot that is not between two digits (No.10, Uk.F4)", () => {
    expect(normalizeText("Isi Staples Kenko No.10")).toBe("isi staples kenko no 10");
    expect(normalizeText("Map Uk.F4")).toBe("map uk f4");
    expect(normalizeText("Pulpen 0.5mm")).toBe("pulpen 0.5mm");
  });
  it("matches a client's \"no 10\" to the catalog's \"No.10\", not to another size-10 item", () => {
    const catalog = [item(10, "ST10", "ISI STAPLES KENKO NO.10"), item(11, "HD10", "STAPLER KENKO HD-10")];
    const [r] = matchLines([{ name: "Isi staples no 10", qty: 1 }], catalog, none);
    expect(r.candidates[0].id).toBe(10);
  });
});

describe("similarity", () => {
  it("is 1 for identical names and 0 for nothing in common", () => {
    expect(similarity(tokens("Formula sikat gigi"), tokens("FORMULA SIKAT GIGI"))).toBe(1);
    expect(similarity(tokens("lakban"), tokens("FORMULA SIKAT GIGI"))).toBe(0);
  });
  it("penalises a size the item lacks (70g vs 80g paper)", () => {
    const want = tokens("Kertas A4 70gsm Sinar Dunia");
    expect(similarity(want, tokens("SINAR DUNIA KERTAS A4 80GR"))).toBeLessThan(0.6);
  });
  it("is 0 for empty input", () => {
    expect(similarity([], tokens("abc"))).toBe(0);
    expect(similarity(tokens("abc"), [])).toBe(0);
  });
});

describe("matchLines", () => {
  it("matches by code first, case and spaces ignored", () => {
    const [r] = matchLines([{ code: " k-bd70 ", name: "something unrelated" }], CATALOG, none);
    expect(r).toMatchObject({ status: "exact", via: "code", candidates: [{ id: 3, score: 1 }] });
  });

  it("auto-matches a strong, unambiguous, complete name match", () => {
    const [r] = matchLines([{ name: "Stabilo boss highlighter orange" }], CATALOG, none);
    expect(r.status).toBe("match");
    expect(r.candidates[0].id).toBe(1);
  });

  // Regression: "Sinar Dunia" was auto-matched to "BOLA DUNIA" (score 0.857)
  // on the real catalog before the every-word rule.
  it("does not auto-accept when a client word (the brand) is missing from the item", () => {
    const [r] = matchLines([{ name: "Kertas A4 70gsm Sinar Dunia" }], CATALOG, none);
    expect(r.candidates[0].id).toBe(3);
    expect(r.status).toBe("review");
  });

  it("asks for review when the runner-up is too close (blue vs light blue)", () => {
    const [r] = matchLines([{ name: "Spidol permanen Artline 70 biru" }], CATALOG, none);
    expect(r.status).toBe("review");
    expect(r.candidates.map((c) => c.id).slice(0, 2)).toEqual([6, 7]);
  });

  it("returns none when nothing is close", () => {
    const [r] = matchLines([{ name: "Galon air mineral" }], CATALOG, none);
    expect(r.status).toBe("none");
    expect(r.via).toBeNull();
  });

  it("uses a learned alias, client-specific over global", () => {
    const aliases = {
      client: new Map([[normalizeText("Kertas fotokopi"), "K-SD80"]]),
      global: new Map([[normalizeText("Kertas fotokopi"), "K-BD70"]]),
    };
    const [r] = matchLines([{ name: "kertas  FOTOKOPI" }], CATALOG, aliases);
    expect(r).toMatchObject({ status: "exact", via: "alias" });
    expect(r.candidates[0]).toEqual({ id: 4, score: 1 });
    // The alias target isn't repeated among the alternatives.
    expect(r.candidates.filter((c) => c.id === 4)).toHaveLength(1);

    const [g] = matchLines([{ name: "Kertas fotokopi" }], CATALOG, { client: new Map(), global: aliases.global });
    expect(g.candidates[0].id).toBe(3);
  });

  it("ignores an alias whose code is no longer in the catalog", () => {
    const aliases = { client: new Map([["formula sikat gigi", "GONE"]]), global: new Map<string, string>() };
    const [r] = matchLines([{ name: "Formula sikat gigi" }], CATALOG, aliases);
    expect(r).toMatchObject({ status: "match", via: "name" });
  });

  it("keeps the input order and index", () => {
    const rs = matchLines([{ name: "sikat gigi formula" }, { name: "zzz" }], CATALOG, none);
    expect(rs.map((r) => r.index)).toEqual([0, 1]);
  });
});

describe("lineFromCatalog", () => {
  const boxed = item(9, "PB", "PULPEN BOX", {
    cogs: 2000,
    list_price: 3000,
    units: [{ uom: "Box", factor: 12 }],
  });

  it("uses catalog COGS and list price in the base unit", () => {
    const line = lineFromCatalog(boxed, 5);
    expect(line).toMatchObject({ code: "PB", uom: "Pcs", qty: 5, cogs: 2000, rrp: 3000, role: "CORE", estCogs: false });
  });

  it("converts to the requested unit with the item's ratio", () => {
    const line = lineFromCatalog(boxed, 2, { uom: "box" });
    expect(line).toMatchObject({ uom: "Box", cogs: 24000, rrp: 36000 });
    expect(line.priceUom).toBeUndefined();
  });

  it("applies a client-stated ceiling after conversion (it is per the requested unit)", () => {
    const line = lineFromCatalog(boxed, 2, { uom: "Box", rrp: 30000 });
    expect(line).toMatchObject({ uom: "Box", cogs: 24000, rrp: 30000 });
  });

  it("flags an unknown unit instead of converting wrongly", () => {
    const line = lineFromCatalog(boxed, 1, { uom: "Lusin" });
    expect(line).toMatchObject({ uom: "Lusin", cogs: 2000, priceUom: "Pcs" });
  });

  it("treats a same-unit request with different case as the base unit", () => {
    expect(lineFromCatalog(boxed, 1, { uom: "PCS" })).toMatchObject({ uom: "Pcs", cogs: 2000 });
  });

  // Regression: for staff the catalog row has no `cogs` (PE-1); an item with
  // no list price then got rrp NaN, sent as null, and the quote was refused.
  it("never produces NaN when the row has no COGS (staff) and no list price", () => {
    const staffRow = { ...item(11, "Y", "Y", { list_price: 0 }), cogs: undefined } as unknown as CatalogItem;
    const line = lineFromCatalog(staffRow, 2);
    expect(line).toMatchObject({ cogs: 0, rrp: 0, estCogs: true });
    expect(JSON.parse(JSON.stringify(line)).rrp).toBe(0);
  });

  it("marks COGS as estimated when the catalog has none", () => {
    const line = lineFromCatalog(item(10, "X", "X", { cogs: 0, list_price: 500 }), 1);
    expect(line).toMatchObject({ cogs: 0, rrp: 500, estCogs: true });
  });
});
