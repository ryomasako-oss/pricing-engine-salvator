import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { DEFAULT_ASSUMPTIONS, DEFAULT_REGIONS, computeEngine } from "@shared/engine";
import type { DocTemplate, QuoteItem, QuoteMeta } from "@shared/types";
import { quoteWorkbook } from "./xlsx";

const meta: QuoteMeta = {
  quoteNo: "Q-1", date: "2026-10-05", validity: 30, payment: "", delivery: "Franco", notes: "", preparedBy: "Sales", paymentDays: 30, warrantyYears: 1,
};
const items: QuoteItem[] = [
  { id: "a", lineNo: 1, code: "A", name: "Pulpen", uom: "Pcs", qty: 10, cogs: 1000, rrp: 2000, role: "CORE" },
];

function sheetFor(over: Partial<QuoteMeta>, template?: DocTemplate | null) {
  const wb = quoteWorkbook({
    engine: computeEngine(DEFAULT_ASSUMPTIONS, items, DEFAULT_REGIONS), meta: { ...meta, ...over }, assumptions: DEFAULT_ASSUMPTIONS,
    scenario: 0, number: "Q-1", title: "T", clientName: "PT Klien", template,
  } as Parameters<typeof quoteWorkbook>[0]);
  return wb.Sheets["Penawaran"];
}
const headers = (s: XLSX.WorkSheet) => (XLSX.utils.sheet_to_json(s, { header: 1 })[0] as string[]);

describe("quote workbook columns", () => {
  it("keeps every column by default, price in F formatted as money", () => {
    const s = sheetFor({});
    expect(headers(s)).toEqual(["No", "Kode", "Item", "Satuan", "Qty", "Harga satuan", "Total per bulan"]);
    expect(s["F2"].v).toBeGreaterThan(0);
    expect(s["F2"].z).toBe(s["G2"].z);
  });
  it("drops the line total only: item rows have no G value, the totals rows still do", () => {
    const s = sheetFor({ hideLineTotal: true });
    expect(s["G2"]).toBeUndefined();
    expect(JSON.stringify(XLSX.utils.sheet_to_json(s))).toContain("Subtotal per bulan");
  });
  it("is a plain price list without Qty: price moves to E, still money, no totals rows", () => {
    const s = sheetFor({ hideQty: true });
    expect(headers(s)).toEqual(["No", "Kode", "Item", "Satuan", "Harga satuan"]);
    expect(s["E2"].v).toBeGreaterThan(0);
    expect(s["E2"].z).toBeTruthy();
    const text = JSON.stringify(XLSX.utils.sheet_to_json(s));
    expect(text).not.toContain("Subtotal");
    expect(text).not.toContain("Nilai kontrak");
  });
});

describe("quote workbook with a client document template", () => {
  it("without a template the sheet is the same as before: header in row 1, widths per column", () => {
    for (const t of [undefined, null]) {
      const s = sheetFor({}, t);
      expect(headers(s)).toEqual(["No", "Kode", "Item", "Satuan", "Qty", "Harga satuan", "Total per bulan"]);
      expect(s["!cols"]?.map((c) => c.wch)).toEqual([5, 14, 46, 8, 10, 14, 16]);
    }
    expect(sheetFor({ hideLineTotal: true })["!cols"]?.map((c) => c.wch)).toEqual([5, 14, 46, 8, 10, 14, 16]);
    expect(sheetFor({ hideQty: true })["!cols"]?.map((c) => c.wch)).toEqual([5, 14, 46, 8, 14]);
  });

  it("uses the template's headings and order, title and opening above, totals under its total column", () => {
    const s = sheetFor({}, {
      columns: [
        { key: "no", label: "No." }, { key: "name", label: "Uraian" }, { key: "price", label: "Harga (Rp)" },
        { key: "qty", label: "Volume" }, { key: "total", label: "Jumlah" },
      ],
      title: "Surat Penawaran",
      opening: "Dengan hormat,",
    });
    const rows = XLSX.utils.sheet_to_json(s, { header: 1, blankrows: true }) as unknown[][];
    expect(rows[0]).toEqual(["Surat Penawaran"]);
    expect(rows[1]).toEqual(["Dengan hormat,"]);
    expect(rows[3]).toEqual(["No.", "Uraian", "Harga (Rp)", "Volume", "Jumlah"]);
    expect(rows[4][1]).toBe("Pulpen");
    // Subtotal row: its label under Uraian, its value under Jumlah (E), formatted as money; no stray column.
    const sub = rows.findIndex((r) => r?.[1] === "Subtotal per bulan");
    expect(sub).toBeGreaterThan(4);
    expect(s[`E${sub + 1}`].z).toBe("#,##0");
    expect(s[`C5`].z).toBe("#,##0");
    expect(Math.max(...rows.map((r) => r?.length ?? 0))).toBe(5);
  });
});

describe("quote workbook with a held (menyusul) line", () => {
  it("leaves the held line out of the Penawaran rows and totals and names it as item menyusul", () => {
    const withHeld: QuoteItem[] = [
      ...items,
      { id: "b", lineNo: 2, code: "B", name: "Kertas ditolak", uom: "Rim", qty: 5, cogs: 40000, rrp: 60000, role: "CORE", held: true, holdReason: "sales" },
    ];
    const engine = computeEngine(DEFAULT_ASSUMPTIONS, withHeld, DEFAULT_REGIONS);
    const wb = quoteWorkbook({
      engine, meta, assumptions: DEFAULT_ASSUMPTIONS, scenario: 0, number: "Q-1", title: "T", clientName: "PT Klien",
    });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets["Penawaran"]) as Record<string, unknown>[];
    expect(rows.filter((r) => r["Item"] === "Kertas ditolak")).toEqual([]);
    expect(rows.filter((r) => r["Item"] === "Pulpen")).toHaveLength(1);
    const note = rows.find((r) => r["Item"] === "Item menyusul");
    expect(String(note?.["Satuan"])).toContain("Kertas ditolak");
    expect(engine.scen[0].revenue).toBe(engine.rows[0].prices[0] * 10);
  });
});
