import { describe, expect, it } from "vitest";
import { matchLines, type MatchResult } from "./match";
import { RANK_BAND, rerankCandidates, type RankFacts } from "./matchRank";
import { isPriorityBrand } from "./priorityBrands";
import { choicesFromRows, restoreRows, type EditorRow } from "./listDrafts";
import type { CatalogItem } from "./types";

const item = (id: number, code: string, name: string): CatalogItem => ({
  id, code, name, uom: "Pcs", cogs: 1000, list_price: 2000, stock: 0, category: "", source: "manual", updated_at: "",
});
const none = { client: new Map<string, string>(), global: new Map<string, string>() };

describe("tie: a review that is only a close call (Ryoma, 2026-11-09)", () => {
  const catalog = [
    item(1, "H1", "ARTLINE EK-660 HIGHLIGHTER BLUE"), item(2, "H2", "ARTLINE EK-660 HIGHLIGHTER GREEN"),
    item(3, "B1", "BOLA DUNIA KERTAS HVS A4 70GR"),
  ];
  it("marks colour variants that all carry every word the client wrote", () => {
    const [r] = matchLines([{ name: "Highlighter Artline" }], catalog, none);
    expect(r.status).toBe("review");
    expect(r.tie).toBe(true);
  });
  it("never marks a row missing a word the client wrote (maybe the brand)", () => {
    const [r] = matchLines([{ name: "Sinar Dunia kertas HVS A4 70gr" }], catalog, none);
    expect(r.status).toBe("review");
    expect(r.tie).toBeUndefined();
  });
  it("never marks a clear match", () => {
    const [r] = matchLines([{ name: "Highlighter Artline blue" }], catalog, none);
    expect(r.status).toBe("match");
    expect(r.tie).toBeUndefined();
  });
});

describe("rerankCandidates", () => {
  const facts = (o: Record<number, Partial<RankFacts>>) =>
    new Map(Object.entries(o).map(([id, f]) => [Number(id), { sold: 0, inStock: false, priorityBrand: false, ...f }]));
  const review = (cands: [number, number][], over: Partial<MatchResult> = {}): MatchResult => ({
    index: 0, status: "review", via: "name", candidates: cands.map(([id, score]) => ({ id, score })), ...over,
  });

  it("within the band: sold first, then in stock, then a priority brand", () => {
    // "Pulpen Gel Artline", 9 Nov: the 0.875 gel pen had stock 0; the 0.857 one sells.
    const [r] = rerankCandidates([review([[10, 0.875], [11, 0.857], [12, 0.857], [13, 0.6]])], facts({ 11: { sold: 40, inStock: true }, 12: { inStock: true } }));
    expect(r.candidates.map((c) => c.id)).toEqual([11, 12, 10, 13]);
    const [s] = rerankCandidates([review([[10, 0.9], [11, 0.9], [12, 0.9]])], facts({ 12: { priorityBrand: true }, 11: { inStock: true } }));
    expect(s.candidates.map((c) => c.id)).toEqual([11, 12, 10]);
  });
  it("never lets a weaker match past the band, and keeps the order with no facts", () => {
    const [r] = rerankCandidates([review([[10, 0.9], [11, 0.9 - RANK_BAND - 0.001]])], facts({ 11: { sold: 999, inStock: true } }));
    expect(r.candidates.map((c) => c.id)).toEqual([10, 11]);
    const [s] = rerankCandidates([review([[10, 0.9], [11, 0.89]])], new Map());
    expect(s.candidates.map((c) => c.id)).toEqual([10, 11]);
  });
  it("leaves pinned and settled results alone", () => {
    const f = facts({ 11: { sold: 99 } });
    for (const over of [{ via: "si" as const }, { via: "alias" as const }, { status: "match" as const }]) {
      const [r] = rerankCandidates([review([[10, 1], [11, 0.99]], over)], f);
      expect(r.candidates[0].id).toBe(10);
    }
  });
});

describe("isPriorityBrand", () => {
  it.each([
    ["ARTLINE EK-70 BLUE", true], ["CAT ACRYLIC V-TEC 35ML", true], ["Kuas VTEC 210FB", true], ["GM ALVABOARD 2MM", true], ["DISPLAY UNTUK LABEL GM", true],
    ["BOSTIK BLU TACK 75 GM", false], ["BOSTIK GLU STIK 8GM", false], ["JOYKO SPIDOL", false], ["LOGITECH MOUSE", false],
  ])("%s → %s", (name, want) => expect(isPriorityBrand(name)).toBe(want));
});

describe("bulk-accepted rows survive a draft as bulk", () => {
  it("keeps the flag so a reopened draft still never saves them as aliases", () => {
    const it1 = item(1, "H1", "HIGHLIGHTER");
    const items = new Map([[1, it1]]);
    const result: MatchResult = { index: 0, status: "review", via: "name", candidates: [{ id: 1, score: 0.9 }], tie: true };
    const rows: EditorRow[] = [{ request: { name: "highlighter" }, result, chosen: 1, confirmed: true, bulk: true, unitOk: false, extra: [] }];
    const choices = choicesFromRows(rows, items);
    expect(choices[0]).toMatchObject({ confirmed: true, bulk: true });
    expect(restoreRows([{ name: "highlighter" }], [result], choices, items).rows[0]).toMatchObject({ confirmed: true, bulk: true });
  });
});
