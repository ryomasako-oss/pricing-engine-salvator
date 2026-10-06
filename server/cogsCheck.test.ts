import { describe, expect, it } from "vitest";
import { applyHolds } from "./cogsCheck";
import type { CatalogItem, QuoteItem } from "../shared/types";

const catalogItem = (over: Partial<CatalogItem> = {}): CatalogItem => ({
  id: 1, code: "C-1", name: "Item", uom: "Pcs", cogs: 1000, list_price: 2000, stock: 0,
  category: "", source: "", updated_at: "", units: [{ uom: "Box", factor: 12 }], ...over,
});
const line = (over: Partial<QuoteItem> = {}): QuoteItem => ({
  id: "l1", lineNo: 1, code: "C-1", name: "Item", uom: "Pcs", qty: 1, cogs: 0, rrp: 2000, role: "CORE", estCogs: true, ...over,
});
const catalog = (item: CatalogItem) => new Map([[item.code.toLowerCase(), item]]);
const draft = (items: QuoteItem[], status = "draft") => ({ status, items });

describe("applyHolds re-costs a released line that still has the empty COGS it was made with", () => {
  it("takes the catalog COGS, converted to the line's unit", () => {
    const [pcs, box] = applyHolds(draft([line(), line({ id: "l2", uom: "Box" })]), new Map(), catalog(catalogItem())).items;
    expect([pcs.cogs, pcs.estCogs, pcs.held]).toEqual([1000, false, undefined]);
    expect([box.cogs, box.estCogs, box.held]).toEqual([12000, false, undefined]);
  });

  it("keeps the line held when its unit has no ratio to convert the cost", () => {
    const [it] = applyHolds(draft([line({ uom: "Lusin" })]), new Map(), catalog(catalogItem())).items;
    expect([it.cogs, it.held]).toEqual([0, true]);
  });

  it("leaves a cost someone typed, a line still held, a code not in the catalog, and submitted quotes alone", () => {
    const typed = line({ cogs: 900, catalogCogs: 1000, estCogs: false });
    expect(applyHolds(draft([typed]), new Map(), catalog(catalogItem())).items[0]).toEqual(typed);
    const stillHeld = applyHolds(draft([line()]), new Map([["C-1", "COGS kosong di katalog"]]), catalog(catalogItem())).items[0];
    expect([stillHeld.cogs, stillHeld.held]).toEqual([0, true]);
    const notInCatalog = line({ code: "X-9" });
    expect(applyHolds(draft([notInCatalog]), new Map(), catalog(catalogItem())).items[0]).toEqual(notInCatalog);
    const submitted = draft([line()], "submitted");
    expect(applyHolds(submitted, new Map(), catalog(catalogItem()))).toBe(submitted);
  });
});

// Codex re-review: a line held because its COGS looked wrong (not empty) kept
// that number after the catalog was corrected, and auto-approved below cost.
describe("applyHolds keeps a draft's catalog copies in step with the catalog", () => {
  const corrected = catalog(catalogItem({ cogs: 1000 }));

  it("a cost still equal to the catalog value it was copied from follows the corrected catalog, in the line's unit", () => {
    const [pcs, box] = applyHolds(
      draft([line({ cogs: 100, catalogCogs: 100, estCogs: false }), line({ id: "l2", uom: "Box", cogs: 1200, catalogCogs: 1200, estCogs: false })]),
      new Map(),
      corrected,
    ).items;
    expect([pcs.cogs, pcs.catalogCogs, pcs.held]).toEqual([1000, 1000, undefined]);
    expect([box.cogs, box.catalogCogs, box.held]).toEqual([12000, 12000, undefined]);
  });

  it("a cost someone typed (different from the catalog copy) is left alone", () => {
    const typed = line({ cogs: 900, catalogCogs: 100, estCogs: false });
    expect(applyHolds(draft([typed]), new Map(), corrected).items[0]).toEqual(typed);
  });

  it("an estimated cost (e.g. from a client's file) takes the catalog's cost once there is one", () => {
    const [it] = applyHolds(draft([line({ cogs: 500, estCogs: true })]), new Map(), corrected).items;
    expect([it.cogs, it.catalogCogs, it.estCogs, it.held]).toEqual([1000, 1000, false, undefined]);
  });

  it("a line without that record (made before it existed) adopts it when its cost matches, and stays held when it doesn't", () => {
    const [same] = applyHolds(draft([line({ cogs: 1000, estCogs: false })]), new Map(), corrected).items;
    expect([same.cogs, same.catalogCogs, same.held]).toEqual([1000, 1000, undefined]);
    const [stale] = applyHolds(draft([line({ cogs: 100, estCogs: false })]), new Map(), corrected).items;
    expect([stale.cogs, stale.held]).toEqual([100, true]);
  });
});
