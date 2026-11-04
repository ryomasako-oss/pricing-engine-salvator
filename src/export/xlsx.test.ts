import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { DEFAULT_ASSUMPTIONS, DEFAULT_REGIONS, computeEngine } from "@shared/engine";
import type { QuoteItem, QuoteMeta } from "@shared/types";
import { quoteWorkbook } from "./xlsx";

const meta: QuoteMeta = {
  quoteNo: "Q-1", date: "2026-10-05", validity: 30, payment: "", delivery: "Franco", notes: "", preparedBy: "Sales", paymentDays: 30, warrantyYears: 1,
};
const items: QuoteItem[] = [
  { id: "a", lineNo: 1, code: "A", name: "Pulpen", uom: "Pcs", qty: 10, cogs: 1000, rrp: 2000, role: "CORE" },
];
const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

async function sheetFor(over: Partial<QuoteMeta>, image?: string) {
  const lines = items.map((it) => ({ ...it, ...(image ? { image } : {}) }));
  const wb = await quoteWorkbook({
    engine: computeEngine(DEFAULT_ASSUMPTIONS, lines, DEFAULT_REGIONS), meta: { ...meta, ...over }, assumptions: DEFAULT_ASSUMPTIONS,
    scenario: 0, number: "Q-1", title: "T", clientName: "PT Klien",
  });
  return { wb, ws: wb.getWorksheet("Penawaran")! };
}

const headers = (ws: ExcelJS.Worksheet): string[] =>
  (ws.getRow(1).values as ExcelJS.CellValue[]).slice(1).map((v) => (v == null ? "" : String(v)));

/** Every non-empty cell text on the sheet, for presence/absence checks. */
const text = (ws: ExcelJS.Worksheet): string => {
  const out: string[] = [];
  ws.eachRow((row) => row.eachCell((cell) => {
    if (cell.value != null) out.push(String(cell.value));
  }));
  return out.join("|");
};

describe("quote workbook columns", () => {
  it("keeps every column by default, price in F formatted as money", async () => {
    const { ws } = await sheetFor({});
    expect(headers(ws)).toEqual(["No", "Kode", "Item", "Satuan", "Qty", "Harga satuan", "Total per bulan"]);
    expect(Number(ws.getCell("F2").value)).toBeGreaterThan(0);
    expect(ws.getCell("F2").numFmt).toBe(ws.getCell("G2").numFmt);
  });

  it("drops the line total only: item rows have no G value, the totals rows still do", async () => {
    const { ws } = await sheetFor({ hideLineTotal: true });
    expect(ws.getCell("G2").value).toBeNull();
    expect(text(ws)).toContain("Subtotal per bulan");
  });

  it("is a plain price list without Qty: price moves to E, still money, no totals rows", async () => {
    const { ws } = await sheetFor({ hideQty: true });
    expect(headers(ws)).toEqual(["No", "Kode", "Item", "Satuan", "Harga satuan"]);
    expect(Number(ws.getCell("E2").value)).toBeGreaterThan(0);
    expect(ws.getCell("E2").numFmt).toBeTruthy();
    const all = text(ws);
    expect(all).not.toContain("Subtotal");
    expect(all).not.toContain("Nilai kontrak");
  });
});

describe("quote workbook photos", () => {
  it("leaves the Foto column and images out when no line has a photo", async () => {
    const { ws } = await sheetFor({});
    expect(headers(ws)).not.toContain("Foto");
    expect(ws.getImages()).toHaveLength(0);
  });

  it("embeds each photo in a Foto column and keeps the file writable", async () => {
    const { wb, ws } = await sheetFor({}, png);
    expect(headers(ws)).toEqual(["No", "Foto", "Kode", "Item", "Satuan", "Qty", "Harga satuan", "Total per bulan"]);
    expect(ws.getImages()).toHaveLength(1);
    expect(ws.getRow(2).height).toBeGreaterThan(20);

    // The image has to survive the actual .xlsx serialization, not just sit in memory.
    const reread = new ExcelJS.Workbook();
    await reread.xlsx.load((await wb.xlsx.writeBuffer()) as ArrayBuffer);
    expect(reread.getWorksheet("Penawaran")!.getImages()).toHaveLength(1);
  });
});
