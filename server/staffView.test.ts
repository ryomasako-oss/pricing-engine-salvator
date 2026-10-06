import { describe, expect, it } from "vitest";
import { DEFAULT_ASSUMPTIONS, DEFAULT_REGIONS, computeEngine } from "../shared/engine";
import type { CatalogItem, PolicyBreach, Quote, QuoteItem } from "../shared/types";
import {
  OUTSIDE_CATALOG,
  auditForViewer,
  breachesForViewer,
  catalogItemsForViewer,
  mergeStaffItems,
  problemsForViewer,
  quoteForViewer,
  quoteRowForViewer,
  settingsForViewer,
} from "./staffView";

const cat = (over: Partial<CatalogItem> = {}): CatalogItem => ({
  id: 1, code: "PEN", name: "Pulpen", uom: "Pcs", cogs: 2000, list_price: 3000, stock: 0,
  category: "", source: "", updated_at: "", units: [{ uom: "Box", factor: 12 }], ...over,
});
const catalog = new Map([["pen", cat()]]);

const stored: QuoteItem = {
  id: "a", lineNo: 1, code: "PEN", name: "Pulpen", uom: "Pcs", qty: 10,
  cogs: 2000, rrp: 3000, role: "LEADER", manualPrice: [2500, null, null],
};

describe("mergeStaffItems", () => {
  it("keeps the stored cost, role and manual price; takes qty, ceiling and notes", () => {
    const r = mergeStaffItems([stored], [{ id: "a", code: "PEN", name: "x", qty: 4, rrp: 2800, notes: "n" }], catalog);
    expect(r).toEqual({ items: [{ ...stored, qty: 4, rrp: 2800, notes: "n" }] });
  });

  it("converts a unit change with the item's ratio and ignores a ceiling sent in the same edit", () => {
    const r = mergeStaffItems([stored], [{ id: "a", code: "PEN", name: "x", qty: 2, uom: "box", rrp: 1 }], catalog);
    expect("items" in r && r.items[0]).toMatchObject({ uom: "Box", qty: 2, cogs: 24000, rrp: 36000, role: "LEADER" });
  });

  it("builds a new line from the catalog by code, whatever its case or spacing", () => {
    const r = mergeStaffItems([], [{ id: "n", code: " pen ", name: "", qty: 3, uom: "Box", rrp: 30000 }], catalog);
    expect(r).toEqual({
      items: [expect.objectContaining({ id: "n", lineNo: 1, code: "PEN", cogs: 24000, rrp: 30000, role: "CORE", qty: 3, uom: "Box" })],
    });
  });

  it("refuses a new line that isn't in the catalog", () => {
    expect(mergeStaffItems([], [{ id: "x", code: "", name: "Barang lain", qty: 1 }], catalog)).toEqual({
      error: OUTSIDE_CATALOG,
      code: "Barang lain",
    });
  });

  it("drops lines the rep removed and renumbers in the order sent", () => {
    const b = { ...stored, id: "b", lineNo: 2 };
    const r = mergeStaffItems([stored, b], [{ id: "b", code: "PEN", name: "", qty: 1 }], catalog);
    expect("items" in r && r.items.map((i) => [i.id, i.lineNo])).toEqual([["b", 1]]);
  });

  it("never reads cost fields an old client still sends", () => {
    const sneaky = { id: "a", code: "PEN", name: "", qty: 10, cogs: 1, role: "PROFIT", manualPrice: [1, 1, 1] } as never;
    const r = mergeStaffItems([stored], [sneaky], catalog);
    expect("items" in r && r.items[0]).toMatchObject({ cogs: 2000, role: "LEADER", manualPrice: [2500, null, null] });
  });
});

describe("quoteForViewer", () => {
  const quote = {
    id: 1, number: "Q", title: "T", client_id: null, status: "draft", scenario: 0, rev_no: 1, version: 1,
    created_by: 1, assigned_to: null, assumptions: DEFAULT_ASSUMPTIONS, regions: DEFAULT_REGIONS,
    items: [{ ...stored, manualPrice: undefined, role: "CORE" as const }],
    meta: { quoteNo: "", date: "2026-10-05", validity: 30, payment: "", delivery: "", notes: "" },
  } as unknown as Quote;

  it("gives a manager the quote untouched", () => {
    expect(quoteForViewer("manager", quote)).toBe(quote);
  });

  it("gives staff the engine's price per line and a total, without cost inputs", () => {
    const v = quoteForViewer("rep", quote) as Record<string, unknown>;
    const engine = computeEngine(DEFAULT_ASSUMPTIONS, quote.items, DEFAULT_REGIONS);
    expect(v.items).toEqual([
      { id: "a", lineNo: 1, code: "PEN", name: "Pulpen", uom: "Pcs", qty: 10, rrp: 3000, price: engine.rows[0].prices[0] },
    ]);
    expect(v.pricing).toMatchObject({ subtotal: engine.scen[0].revenue, ppnRate: 0.11, months: 12 });
    expect(v).not.toHaveProperty("assumptions");
    expect(v).not.toHaveProperty("regions");
    expect(JSON.stringify(v)).not.toMatch(/"(cogs|landed|margins?|manualPrice|role)":/);
  });
});

describe("what staff read", () => {
  const breaches: PolicyBreach[] = [
    { code: "NET_MARGIN", severity: "block", message: "Net margin 4,2% di bawah batas kebijakan 15,0%.", lines: [] },
    { code: "LINE_MARGIN", severity: "warn", message: "2 item marginnya di bawah batas per item 5,0%.", lines: [1, 2] },
  ];

  it("breach wording carries no numbers for staff, keeps codes and line numbers", () => {
    const b = breachesForViewer("rep", breaches);
    expect(b.map((x) => x.message).join(" ")).not.toMatch(/\d/);
    expect(b.map((x) => [x.code, x.severity, x.lines])).toEqual([["NET_MARGIN", "block", []], ["LINE_MARGIN", "warn", [1, 2]]]);
    expect(breachesForViewer("admin", breaches)).toBe(breaches);
  });

  it("catalog rows lose COGS and the problem's amounts", () => {
    const rows = [{ ...cat(), cogs_problem: "COGS Rp 2.000 lebih tinggi dari harga jual katalog Rp 1.500" }];
    const [r] = catalogItemsForViewer("rep", rows);
    expect(r).not.toHaveProperty("cogs");
    expect(r.cogs_problem).toBe("COGS item ini perlu dicek manajer");
    expect(catalogItemsForViewer("rep", [{ ...cat(), cogs_problem: null }])[0].cogs_problem).toBeNull();
  });

  it("problems, list rows and settings are trimmed for staff only", () => {
    const p = new Map([["PEN", "COGS Rp 2.000 …"]]);
    expect([...problemsForViewer("rep", p)]).toEqual([["PEN", "COGS item ini perlu dicek manajer"]]);
    expect(problemsForViewer("manager", p)).toBe(p);
    expect(quoteRowForViewer("rep", { id: 1, net_margin: 0.2 })).toEqual({ id: 1 });
    expect(settingsForViewer("rep", { policy: { minNetMargin: 0.15 }, company: { name: "S" } })).toEqual({ company: { name: "S" } });
  });
});

describe("auditForViewer", () => {
  const entry = (detail: string) => ({ id: 1, actor_name: "A", entity: "quote", entity_id: 1, action: "submitted", detail, created_at: "" });

  // Regression: the submit entry recorded net_margin and GET /quotes/:id sent
  // the audit trail to everyone; the leak probe missed it until it re-read the
  // quote after submitting and matched keys inside JSON strings.
  it("drops margin from the submit entry for staff, keeps the rest", () => {
    const [e] = auditForViewer("rep", [entry(JSON.stringify({ breaches: ["NET_MARGIN"], monthly_value: 100, net_margin: 0.04 }))]);
    expect(JSON.parse(e.detail)).toEqual({ breaches: ["NET_MARGIN"], monthly_value: 100 });
  });

  it("leaves non-JSON details alone and managers untouched", () => {
    expect(auditForViewer("rep", [entry("plain text")])[0].detail).toBe("plain text");
    const all = [entry(JSON.stringify({ net_margin: 0.04 }))];
    expect(auditForViewer("manager", all)).toBe(all);
  });
});
