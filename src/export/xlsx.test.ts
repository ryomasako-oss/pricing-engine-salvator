import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { DEFAULT_ASSUMPTIONS, DEFAULT_REGIONS, computeEngine } from "@shared/engine";
import type { QuoteItem, QuoteMeta } from "@shared/types";
import { quoteWorkbook } from "./xlsx";

const meta: QuoteMeta = {
  quoteNo: "Q-1", date: "2026-10-05", validity: 30, payment: "", delivery: "Franco", notes: "", preparedBy: "Sales", paymentDays: 30, warrantyYears: 1,
};
const items: QuoteItem[] = [
  { id: "a", lineNo: 1, code: "A", name: "Pulpen", uom: "Pcs", qty: 10, cogs: 1000, rrp: 2000, role: "CORE" },
];

function sheetFor(over: Partial<QuoteMeta>) {
  const wb = quoteWorkbook({
    engine: computeEngine(DEFAULT_ASSUMPTIONS, items, DEFAULT_REGIONS), meta: { ...meta, ...over }, assumptions: DEFAULT_ASSUMPTIONS,
    scenario: 0, number: "Q-1", title: "T", clientName: "PT Klien",
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
