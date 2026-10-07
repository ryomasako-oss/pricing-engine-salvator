import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { DEFAULT_ASSUMPTIONS, DEFAULT_REGIONS, computeEngine } from "@shared/engine";
import type { QuoteItem, QuoteMeta, ScenarioIndex } from "@shared/types";
import { COLUMNS, SEAL, SHEET, readSalesReview, salesReviewWorkbook } from "./salesReview";

const meta: QuoteMeta = {
  quoteNo: "Q-1", date: "2026-10-06", validity: 30, payment: "setelah invoice", delivery: "Franco Jakarta",
  notes: "", preparedBy: "Manajer", paymentDays: 30, warrantyYears: 1,
};

const items: QuoteItem[] = [
  { id: "a", lineNo: 1, code: "P1", name: "Pulpen", uom: "Pcs", qty: 200, cogs: 2000, rrp: 3000, role: "CORE" },
  { id: "b", lineNo: 2, code: "K1", name: "Kertas A4", uom: "Rim", qty: 50, cogs: 47000, rrp: 52000, role: "PROFIT" },
  { id: "c", lineNo: 3, code: "L1", name: "Lakban", uom: "Pcs", qty: 100, cogs: 8000, rrp: 12000, role: "LEADER" },
  { id: "d", lineNo: 4, code: "T1", name: "Tinta", uom: "Btl", qty: 20, cogs: 1, rrp: 95000, role: "CORE", held: true },
];

async function file(scenario: ScenarioIndex = 2) {
  const engine = computeEngine(DEFAULT_ASSUMPTIONS, items, DEFAULT_REGIONS);
  const wb = await salesReviewWorkbook({
    engine, meta, assumptions: DEFAULT_ASSUMPTIONS, scenario, quoteId: 7, number: "Q-1", title: "ATK",
    clientName: "PT Klien", revNo: 2, version: 5, password: "kantor123",
  });
  return { engine, wb };
}

const rowOf = (ws: ExcelJS.Worksheet, id: string) => {
  let found: ExcelJS.Row | undefined;
  ws.eachRow((row) => {
    if (row.getCell(COLUMNS.id).value === id) found = row;
  });
  if (!found) throw new Error(`row ${id} missing`);
  return found;
};

async function roundTrip(wb: ExcelJS.Workbook) {
  const buf = await wb.xlsx.writeBuffer();
  return readSalesReview(buf as ArrayBuffer);
}

describe("sales review workbook", () => {
  it("shows the engine's own price, margin and COGS for every line, in every scenario", async () => {
    for (const k of [0, 1, 2] as ScenarioIndex[]) {
      const { engine, wb } = await file(k);
      const ws = wb.getWorksheet(SHEET)!;
      for (const r of engine.rows.filter((x) => !x.held)) {
        const row = rowOf(ws, r.id);
        expect(row.getCell(COLUMNS.price).value, `${r.name} S${k + 1}`).toBe(r.prices[k]);
        expect(row.getCell(COLUMNS.margin).value).toBe(r.margins[k]);
        expect(row.getCell(COLUMNS.cogs).value).toBe(r.cogs);
        // The explanation is the breakdown's, so it ends on the same price.
        expect(String(row.getCell(COLUMNS.how).value)).toContain(`Harga akhir Rp ${r.prices[k].toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".")}`);
      }
    }
  });

  it("protects every sheet with the password and unlocks only ACC/Tolak and Alasan on offered lines", async () => {
    const { wb } = await file();
    const ws = wb.getWorksheet(SHEET)!;
    // ExcelJS keeps protection on an untyped field.
    const isProtected = (w: ExcelJS.Worksheet) => (w as unknown as { sheetProtection?: { sheet?: boolean } }).sheetProtection?.sheet;
    expect(isProtected(ws)).toBe(true);
    expect(isProtected(wb.getWorksheet("Ringkasan")!)).toBe(true);
    const unlocked: string[] = [];
    ws.eachRow({ includeEmpty: true }, (row) =>
      row.eachCell({ includeEmpty: true }, (c) => {
        if (c.protection?.locked === false) unlocked.push(c.address);
      }),
    );
    const offeredRows = ["a", "b", "c"].map((id) => rowOf(ws, id).number);
    expect(unlocked.sort()).toEqual(offeredRows.flatMap((n) => [`${COLUMNS.decision}${n}`, `${COLUMNS.reason}${n}`]).sort());
    expect(ws.getCell(`${COLUMNS.decision}${offeredRows[0]}`).dataValidation?.formulae).toEqual(['"ACC,Tolak"']);
    expect(wb.getWorksheet(SEAL)!.state).toBe("veryHidden");
  });

  it("marks a held line and leaves it out of the decisions", async () => {
    const { wb } = await file();
    const held = rowOf(wb.getWorksheet(SHEET)!, "d");
    expect(held.getCell(COLUMNS.decision).value).toBe("DITAHAN");
    expect(held.getCell(COLUMNS.price).value).toBeNull();
    const read = await roundTrip(wb);
    expect(read.lines.map((l) => l.id)).toEqual(["a", "b", "c"]);
  });

  it("shows a line already rejected by sales as menyusul, locked, with no decision", async () => {
    const engine = computeEngine(DEFAULT_ASSUMPTIONS, items.map((it) => (it.id === "b" ? { ...it, held: true, holdReason: "sales" as const } : it)), DEFAULT_REGIONS);
    const wb = await salesReviewWorkbook({
      engine, meta, assumptions: DEFAULT_ASSUMPTIONS, scenario: 2, quoteId: 7, number: "Q-1", title: "ATK",
      clientName: "PT Klien", revNo: 2, version: 6, password: "kantor123",
    });
    const row = rowOf(wb.getWorksheet(SHEET)!, "b");
    expect(row.getCell(COLUMNS.decision).value).toBe("DITAHAN");
    expect(row.getCell(COLUMNS.decision).protection?.locked).not.toBe(false);
    expect(String(row.getCell(COLUMNS.how).value)).toMatch(/^Menyusul/);
    expect((await roundTrip(wb)).lines.map((l) => l.id)).toEqual(["a", "c"]);
  });

  it("reads back the seal and the decisions, accepting any case", async () => {
    const { wb } = await file();
    const ws = wb.getWorksheet(SHEET)!;
    rowOf(ws, "a").getCell(COLUMNS.decision).value = "ACC";
    rowOf(ws, "b").getCell(COLUMNS.decision).value = "tolak";
    rowOf(ws, "b").getCell(COLUMNS.reason).value = "  klien minta 48rb ";
    rowOf(ws, "c").getCell(COLUMNS.decision).value = "ok deh";
    const read = await roundTrip(wb);
    expect(read).toMatchObject({ quoteId: 7, revNo: 2, version: 5 });
    expect(read.lines).toEqual([
      { id: "a", lineNo: 1, name: "Pulpen", decision: "acc", reason: "" },
      { id: "b", lineNo: 2, name: "Kertas A4", decision: "tolak", reason: "klien minta 48rb" },
      { id: "c", lineNo: 3, name: "Lakban", decision: null, reason: "" },
    ]);
    expect(read.invalid).toEqual([{ lineNo: 3, name: "Lakban", value: "ok deh" }]);
  });

  it("never reads a price: a price edited in the file is not part of what is sent back", async () => {
    const { wb } = await file();
    rowOf(wb.getWorksheet(SHEET)!, "a").getCell(COLUMNS.price).value = 1;
    const read = await roundTrip(wb);
    expect(JSON.stringify(read)).not.toMatch(/"(price|harga|cogs)"/i);
    expect(Object.keys(read.lines[0]).sort()).toEqual(["decision", "id", "lineNo", "name", "reason"]);
  });

  it("refuses a workbook that is not a sales-review file", async () => {
    const other = new ExcelJS.Workbook();
    other.addWorksheet("Penawaran").addRow(["x"]);
    await expect(readSalesReview((await other.xlsx.writeBuffer()) as ArrayBuffer)).rejects.toThrow(/bukan file "Cek harga"/);
    await expect(readSalesReview(new TextEncoder().encode("not a zip").buffer as ArrayBuffer)).rejects.toThrow(/bukan Excel/);
  });
});
