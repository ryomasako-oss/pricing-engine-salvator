import { describe, expect, it } from "vitest";
import { buildSearchIndex, queryKey, searchCatalog, typoDistance } from "./catalogSearch";

const docs = [
  { code: "101118", name: "FASTER PULPEN C-6 BLACK", category: "GENERAL" },
  { code: "80801784", name: "ARTLINE COMIC PEN EK-281 HITAM", category: "ARTLINE" },
  { code: "100649", name: "JOYKO PULPEN GP 338 HITAM", category: "GENERAL" },
  { code: "20057901", name: "V-TEC KUAS 579F - 1", category: "V-TEC" },
  { code: "100715", name: "RAK GALON 4 SUSUN", category: "GENERAL" },
  { code: "100421", name: "BOLA DUNIA KERTAS A4 70GR", category: "GENERAL" },
  { code: "100422", name: "BOLA DUNIA KERTAS A4 80GR", category: "GENERAL" },
  { code: "103197", name: "STABILO BOSS HIGHLIGHTER PINK", category: "GENERAL" },
  { code: "GM-1", name: "GM ALVABOARD 2MM COKLAT", category: "GM Stationery" },
  { code: "B-21", name: "BOSTIK GLU STIK 21 GM", category: "GENERAL" },
];
const index = buildSearchIndex(docs);
const PRIORITY = ["ARTLINE", "V-TEC", "GM Stationery"];
const codes = (q: string) => searchCatalog(index, q, { priority: PRIORITY }).items.map((d) => d.code);

describe("searchCatalog", () => {
  it("matches every word in any order, with synonyms (hitam = black, pulpen = pen)", () => {
    expect(codes("pulpen hitam")).toEqual(codes("hitam pulpen"));
    expect(codes("pulpen hitam")).toEqual(expect.arrayContaining(["101118", "80801784", "100649"]));
    expect(codes("pulpen hitam")).not.toContain("100715");
  });

  it("puts the priority brands first among equal matches, and keeps the rest", () => {
    const r = codes("pulpen hitam");
    expect(r[0]).toBe("80801784");
    expect(r).toHaveLength(3);
  });

  it("matches the word still being typed as a start", () => {
    expect(codes("rak gal")).toEqual(["100715"]);
    expect(codes("pulpe")).toEqual(expect.arrayContaining(["101118", "100649"]));
  });

  it("never treats a size as a typo: a4 70 is not a4 80", () => {
    expect(codes("kertas a4 70")).toEqual(["100421"]);
  });

  it("finds a typo and suggests the catalog spelling", () => {
    const r = searchCatalog(index, "stablio", { priority: PRIORITY });
    expect(r.items.map((d) => d.code)).toEqual(["103197"]);
    expect(r.suggestion).toBe("stabilo");
    expect(searchCatalog(index, "stabilo", { priority: PRIORITY }).suggestion).toBeNull();
  });

  it("reads a priority brand in any spelling", () => {
    expect(codes("vitek kuas")).toEqual(["20057901"]);
    expect(codes("v tec")).toContain("20057901");
  });

  it("finds by code", () => {
    expect(codes("100715")).toEqual(["100715"]);
  });

  it("shows the items missing one word when none has them all, marked partial", () => {
    const r = searchCatalog(index, "rak galon besi", { priority: PRIORITY });
    expect(r.partial).toBe(true);
    expect(r.items.map((d) => d.code)).toEqual(["100715"]);
  });

  it("an empty query lists everything, priority brands first", () => {
    const r = codes("");
    expect(r).toHaveLength(docs.length);
    expect(PRIORITY.length).toBe(3);
    expect(["80801784", "20057901", "GM-1"]).toContain(r[0]);
  });
});

describe("typoDistance", () => {
  it("counts a swap of two letters as one typo", () => {
    expect(typoDistance("stablio", "stabilo")).toBe(1);
    expect(typoDistance("kertas", "kretas")).toBe(1);
    expect(typoDistance("abc", "xyz", 1)).toBe(2);
  });
});

describe("learning from habit", () => {
  const learnDocs = [
    { code: "M1", name: "SNOWMAN MARKER BIRU", category: "GENERAL", popularity: 0 },
    { code: "M2", name: "JOYKO MARKER BIRU", category: "GENERAL", popularity: 40 },
    { code: "M3", name: "ARTLINE MARKER BIRU", category: "ARTLINE", popularity: 0 },
    { code: "ZQ1", name: "ZQSI PELUMAS RANTAI", category: "GENERAL", aliases: ["oli rantai 800ml"] },
    { code: "ATK-001", name: "PULPEN STANDARD", category: "GENERAL" },
  ];
  const idx = buildSearchIndex(learnDocs);
  const order = (q: string, picked?: Map<string, number>) =>
    searchCatalog(idx, q, { priority: ["ARTLINE"], picked }).items.map((d) => d.code);

  it("an often sold/bought/quoted item rises among equal matches, under the priority brand", () => {
    expect(order("marker biru")).toEqual(["M3", "M2", "M1"]);
  });

  it("an item picked after these words comes first, above the priority brand", () => {
    expect(order("marker biru", new Map([["M1", 2]]))).toEqual(["M1", "M3", "M2"]);
  });

  it("a client's wording learned in Pencocokan finds the item", () => {
    expect(order("oli rantai")).toEqual(["ZQ1"]);
  });

  it("habit never brings in an item the words don't find", () => {
    expect(order("oli rantai", new Map([["M1", 9]]))).toEqual(["ZQ1"]);
  });

  it("a piece of a code finds the item", () => {
    expect(order("k-001")).toEqual(["ATK-001"]);
  });

  it("the priority order counts: the first category ranks above the second", () => {
    const two = buildSearchIndex([
      { code: "V1", name: "V-TEC KUAS", category: "V-TEC" },
      { code: "A1", name: "ARTLINE KUAS", category: "ARTLINE" },
    ]);
    expect(searchCatalog(two, "kuas", { priority: ["V-TEC", "ARTLINE"] }).items.map((d) => d.code)).toEqual(["V1", "A1"]);
    expect(searchCatalog(two, "kuas", { priority: ["ARTLINE", "V-TEC"] }).items.map((d) => d.code)).toEqual(["A1", "V1"]);
  });

  it("the same words in any order are one habit", () => {
    expect(queryKey("Biru  marker")).toBe(queryKey("marker biru"));
  });
});
