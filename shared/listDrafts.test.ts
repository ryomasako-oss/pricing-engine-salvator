import { describe, expect, it } from "vitest";
import { choicesFromRows, codesToFetch, restoreRows, type DraftChoice, type EditorRow } from "./listDrafts";
import type { MatchResult, RequestLine } from "./match";
import type { CatalogItem } from "./types";

const item = (id: number, code: string, over: Partial<CatalogItem> = {}): CatalogItem => ({
  id, code, name: `Barang ${code}`, uom: "Pcs", cogs: 1000, list_price: 2000, stock: 0, category: "", source: "manual", updated_at: "", ...over,
});
const lines: RequestLine[] = [{ name: "pulpen" }, { name: "kertas" }, { name: "lem" }, { name: "map" }];
const result = (index: number, status: MatchResult["status"], ids: number[]): MatchResult => ({
  index, status, via: status === "none" ? null : "name", candidates: ids.map((id) => ({ id, score: 0.9 })),
});

describe("choicesFromRows: what a draft keeps", () => {
  it("keeps codes, a barang baru without cost, and manual-search codes; never ids or prices of catalog items", () => {
    const items = new Map([
      [1, item(1, "P1")], [2, item(2, "K1")], [9, item(9, "MANUAL")],
      [-4, item(-4, "BARU-0004", { source: "pending", cogs: 0, list_price: 1500, name: "Map biru" })],
    ]);
    const rows: EditorRow[] = [
      { request: lines[0], result: result(0, "match", [1]), chosen: 1, confirmed: true, extra: [] },
      { request: lines[1], result: result(1, "review", [2]), chosen: 9, confirmed: true, extra: [9] },
      { request: lines[2], result: result(2, "none", []), chosen: null, confirmed: true, extra: [] },
      { request: lines[3], result: result(3, "none", []), chosen: -4, confirmed: true, extra: [-4] },
    ];
    const choices = choicesFromRows(rows, items);
    expect(choices).toEqual([
      { chosen: { kind: "catalog", code: "P1" }, confirmed: true, extra: [] },
      { chosen: { kind: "catalog", code: "MANUAL" }, confirmed: true, extra: ["MANUAL"] },
      // A row left out is never "confirmed": confirming means a pairing was accepted.
      { chosen: null, confirmed: false, extra: [] },
      { chosen: { kind: "pending", pendingId: 4, code: "BARU-0004", name: "Map biru", uom: "Pcs", price: 1500 }, confirmed: true, extra: [] },
    ]);
    expect(JSON.stringify(choices)).not.toMatch(/cogs|"id"/);
  });
});

describe("restoreRows: picks laid over a fresh match", () => {
  const saved: DraftChoice[] = [
    { chosen: { kind: "catalog", code: "p1" }, confirmed: true, extra: [] }, // case differs: still the same code
    { chosen: { kind: "catalog", code: "MANUAL" }, confirmed: true, extra: ["MANUAL"] },
    { chosen: { kind: "catalog", code: "GONE" }, confirmed: true, extra: [] },
    { chosen: { kind: "pending", pendingId: 4, code: "BARU-0004", name: "Map biru", uom: "Pcs", price: 1500 }, confirmed: true, extra: [] },
  ];
  const results = [result(0, "review", [2, 1]), result(1, "review", [2]), result(2, "match", [3]), result(3, "none", [])];

  it("restores each pick by code, adds a manual pick to the row's options, and rebuilds a barang baru", () => {
    const items = new Map([[1, item(1, "P1")], [2, item(2, "K1")], [3, item(3, "L1")], [9, item(9, "MANUAL")]]);
    const { rows, extraItems, lost } = restoreRows(lines, results, saved, items);
    expect(rows.map((r) => [r.chosen, r.confirmed, r.extra])).toEqual([
      [1, true, []], // the saved pick wins over the matcher's first guess
      [9, true, [9]],
      // GONE is no longer in the catalog: cleared and unconfirmed, not silently swapped for L1.
      [null, false, []],
      [-4, true, [-4]],
    ]);
    expect(lost).toBe(1);
    expect(extraItems).toEqual([expect.objectContaining({ id: -4, code: "BARU-0004", cogs: 0, source: "pending" })]);
  });

  it("a barang baru that reached the catalog under its code is used as the catalog item", () => {
    const items = new Map([[1, item(1, "P1")], [9, item(9, "MANUAL")], [44, item(44, "BARU-0004")]]);
    const { rows, extraItems } = restoreRows(lines, results, saved, items);
    expect(rows[3].chosen).toBe(44);
    expect(extraItems).toEqual([]);
  });

  it("a line without a saved choice keeps the matcher's own default", () => {
    const items = new Map([[2, item(2, "K1")], [1, item(1, "P1")]]);
    const { rows } = restoreRows(lines.slice(0, 1), [results[0]], [], items);
    expect(rows[0]).toMatchObject({ chosen: 2, confirmed: false });
  });

  it("codesToFetch asks only for picked codes the match didn't return", () => {
    expect(codesToFetch(saved, [item(1, "P1"), item(2, "K1")]).sort()).toEqual(["GONE", "MANUAL"]);
  });
});
