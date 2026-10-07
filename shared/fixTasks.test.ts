import { describe, expect, it } from "vitest";
import { ageDays, dedupeKey, digestEmail, tasksFromItems, tasksFromSalesRejection, tasksFromUnmatched, type OpenTaskRow } from "./fixTasks";
import type { QuoteItem } from "./types";

const item = (over: Partial<QuoteItem>): QuoteItem => ({
  id: "a", lineNo: 1, code: "P1", name: "Pulpen", uom: "Pcs", qty: 10, cogs: 1000, rrp: 2000, role: "CORE", ...over,
});

describe("tasksFromItems", () => {
  it("makes a COGS task for a COGS hold, with the catalog's problem text", () => {
    const t = tasksFromItems(5, [item({ held: true })], new Map([["P1", "COGS kosong"]]));
    expect(t).toEqual([{ kind: "cogs_held", quote_id: 5, line_id: "a", code: "P1", item_name: "Pulpen", qty: 10, uom: "Pcs", detail: "COGS kosong" }]);
  });
  it("does not make a COGS task for a line held because sales rejected it", () => {
    expect(tasksFromItems(5, [item({ held: true, holdReason: "sales" })])).toEqual([]);
  });
  it("makes a unit task for a unit with no ratio, and nothing for a clean line", () => {
    const t = tasksFromItems(5, [item({ uom: "Lusin", priceUom: "Pcs" }), item({ id: "b" })]);
    expect(t.map((x) => [x.kind, x.line_id])).toEqual([["unit_unknown", "a"]]);
    expect(t[0].detail).toMatch(/Rasio Lusin belum ada/);
  });
});

describe("tasksFromUnmatched / tasksFromSalesRejection", () => {
  it("keeps every named row of the client's list, saying why it is missing", () => {
    const t = tasksFromUnmatched(9, [
      { name: " Galon air ", qty: 3, uom: "Pcs", reason: "none" },
      { name: "Map plastik", qty: 0, uom: "", reason: "skipped" },
      { name: "  ", qty: 1, uom: "", reason: "none" },
    ]);
    expect(t.map((x) => [x.kind, x.item_name, x.line_id])).toEqual([["not_in_catalog", "Galon air", null], ["not_in_catalog", "Map plastik", null]]);
    expect(t[0].detail).toMatch(/tidak ditemukan/);
    expect(t[1].detail).toMatch(/tidak dipakai/);
  });
  it("makes one task per rejected line with the reviewer and reason", () => {
    const t = tasksFromSalesRejection(9, [{ id: "a", reason: "mahal" }, { id: "zz", reason: "x" }], [item({})], "Sales Satu");
    expect(t).toEqual([{ kind: "sales_rejected", quote_id: 9, line_id: "a", code: "P1", item_name: "Pulpen", qty: 10, uom: "Pcs", detail: "Ditolak Sales Satu: mahal" }]);
  });
});

describe("dedupeKey", () => {
  it("is the same for the same problem on the same line, and differs across kinds, quotes and lines", () => {
    const k = { kind: "cogs_held" as const, quote_id: 1, line_id: "a", item_name: "X" };
    expect(dedupeKey(k)).toBe(dedupeKey({ ...k, item_name: "renamed" }));
    expect(new Set([dedupeKey(k), dedupeKey({ ...k, kind: "unit_unknown" }), dedupeKey({ ...k, quote_id: 2 }), dedupeKey({ ...k, line_id: "b" })]).size).toBe(4);
  });
  it("uses the normalised name for list rows", () => {
    const k = { kind: "not_in_catalog" as const, quote_id: 1, line_id: null };
    expect(dedupeKey({ ...k, item_name: "Galon  AIR" })).toBe(dedupeKey({ ...k, item_name: "galon air" }));
  });
});

describe("digestEmail", () => {
  const now = new Date("2026-10-08T01:00:00Z");
  const row = (over: Partial<OpenTaskRow>): OpenTaskRow => ({
    id: 1, kind: "cogs_held", item_name: "Tinta", qty: 2, uom: "Btl", detail: "COGS kosong",
    created_at: "2026-10-06 03:00:00", quote_number: "Q-1", client_name: "PT A", ...over,
  });
  it("is null when nothing is open", () => {
    expect(digestEmail([], now, "https://x/perbaikan")).toBeNull();
  });
  it("counts, names the oldest age, groups by kind and escapes text", () => {
    const d = digestEmail([row({}), row({ id: 2, kind: "not_in_catalog", item_name: "<b>Galon</b>", created_at: "2026-10-07 23:00:00" })], now, "https://x/perbaikan")!;
    expect(d.subject).toBe("Perlu diperbaiki: 2 item terbuka (tertua 1 hari)");
    expect(d.html).toContain("Tidak ada di katalog (1)");
    expect(d.html).toContain("COGS perlu dicek (1)");
    expect(d.html).toContain("&lt;b&gt;Galon&lt;/b&gt;");
    expect(d.html).not.toContain("<b>Galon</b>");
    expect(d.html).toContain('href="https://x/perbaikan"');
  });
  it("ageDays reads SQLite UTC timestamps", () => {
    expect(ageDays("2026-10-06 01:00:00", now)).toBe(2);
    expect(ageDays("garbage", now)).toBe(0);
  });
});
