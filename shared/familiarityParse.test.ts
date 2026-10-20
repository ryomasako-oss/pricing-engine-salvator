import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { parseFamiliarityFile, type FamiliarityFile } from "./familiarityParse.js";

/** A workbook in the shape parseFamiliarityFile accepts (Name + arrayBuffer). */
function workbookFile(sheets: [string, unknown[][]][], name = "list.xlsx"): FamiliarityFile {
  const wb = XLSX.utils.book_new();
  for (const [sheetName, grid] of sheets) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(grid), sheetName);
  }
  const bytes = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
  return { name, type: "", arrayBuffer: async () => bytes, text: async () => "" };
}

describe("parseFamiliarityFile", () => {
  it("reads a data sheet even when the first sheet is only a cover", async () => {
    const { lines, report } = await parseFamiliarityFile(
      workbookFile([
        ["Ringkasan", [["Daftar kebutuhan ATK"], ["Harga belum termasuk PPN"]]],
        ["Data", [["NO", "ITEM CODE", "DES", "QTY", "Satuan"], [1, "FAM-PEN", "PULPEN GEL", 2, "Pcs"]]],
      ]),
    );
    expect(lines).toEqual([{ text: "PULPEN GEL", code: "FAM-PEN", qty: 2, unit: "Pcs" }]);
    expect(report.sheets).toEqual(["Data"]);
  });

  it("still explains when no sheet has an item header", async () => {
    await expect(parseFamiliarityFile(workbookFile([["Ringkasan", [["Harga belum termasuk PPN"]]]]))).rejects.toThrow(
      /tidak punya baris judul/,
    );
  });
});
