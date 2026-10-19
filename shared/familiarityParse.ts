/* ============================================================
   Client-list parsing for the interactive familiarity feed.

   This is the server-side twin of src/import/parsers.ts (the browser
   parser). It deliberately follows PR #40's rules:

   - a description header (DES, Deskripsi, Uraian, …) names the item,
     never a header that merely starts with "item" (CGV's "ITEM CODE");
   - every sheet with an item header is read, not only the first;
   - the client's own code is kept as a hint, and the matcher decides
     whether it may be trusted (shared/match.ts, CODE_NAME_AGREES).

   It runs unchanged in Node and in a Worker: ArrayBuffer/text in,
   plain objects out, no DOM and no filesystem.
   ============================================================ */

import * as XLSX from "xlsx";
import { toNum } from "./format.js";

export interface FamiliarityInputLine {
  /** The wording as the client wrote it, without a code column. */
  text: string;
  qty?: number;
  unit?: string;
  /** A code from a separate column, or one recognised at the start of the text. */
  code?: string;
}

/** The slice of a browser/Worker File this parser needs. */
export interface FamiliarityFile {
  name: string;
  type?: string;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}

export interface FamiliarityParseReport {
  /** Sheets that had an item header, main sheet first. */
  sheets: string[];
  count: number;
  notes: string[];
}

const text = (v: unknown): string => String(v ?? "").trim();
const lower = (v: unknown): string => text(v).toLowerCase();

type Grid = unknown[][];

/** The client list's main sheet: a named one if there is one, else the first. */
const pickClientSheet = (wb: XLSX.WorkBook) =>
  wb.SheetNames.find((n) => /base_economics/i.test(n)) ||
  wb.SheetNames.find((n) => /item|kebutuhan|atk|penawaran|request|rfq/i.test(n)) ||
  wb.SheetNames[0] ||
  "";

/**
 * Header words that name the item itself, tried before anything else.
 * "ITEM CODE" also starts with "item"; CGV's list (NO | ITEM CODE | Gambar |
 * DES | ...) was read with the code as the name and its DES ignored.
 */
const NAME_HEADER = /^(nama barang|nama item|item name|item description|deskripsi|description|desc|des|uraian|urain|barang)\b/;
const CODE_HEADER = /kode|code|sku/;
const CITY =
  /jakarta|bogor|bandung|surabaya|medan|semarang|makassar|palembang|pekanbaru|lampung|jambi|riau|kalimantan|sumatera|bekasi|tangerang|depok|solo|yogya|malang|denpasar|balikpapan/;

function sheetGrid(wb: XLSX.WorkBook, name: string): Grid {
  return XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: "", blankrows: false }) as Grid;
}

function findHeader(rows: Grid, test: (cells: string[]) => boolean, limit = 40): number {
  for (let i = 0; i < Math.min(rows.length, limit); i++) {
    if (test(rows[i].map(lower))) return i;
  }
  return -1;
}

interface Columns {
  sheetName: string;
  rows: Grid;
  hi: number;
  col: { name: number; code: number; uom: number; qty: number };
  cityCols: number[];
}

/** Header row and columns of one sheet, or why it has none. */
function readClientColumns(wb: XLSX.WorkBook, sheetName: string): Columns | { error: string } {
  const rows = sheetGrid(wb, sheetName);
  const hi = findHeader(
    rows,
    (c) =>
      c.some((x) => /item|nama barang|nama|deskripsi|description|barang|^des$/.test(x)) &&
      c.filter(Boolean).length >= 2,
    30,
  );
  if (hi < 0) return { error: `Sheet "${sheetName}" tidak punya baris judul dengan kolom nama item.` };

  const header = rows[hi].map(lower);
  const find = (re: RegExp) => header.findIndex((h) => re.test(h));
  const col = {
    name: find(NAME_HEADER),
    code: find(CODE_HEADER),
    uom: find(/uom|satuan|unit/),
    qty: find(/qty|kuantitas|jumlah|quantity|kebutuhan|kts/),
  };
  if (col.name < 0) col.name = header.findIndex((h) => /^(item|nama)/.test(h) && !CODE_HEADER.test(h));
  if (col.name < 0) col.name = header.findIndex((h) => /item|nama|barang/.test(h) && !CODE_HEADER.test(h));
  if (col.name < 0) return { error: "Kolom nama item tidak ditemukan di baris judul." };

  const cityCols = header.map((h, i) => (CITY.test(h) ? i : -1)).filter((i) => i >= 0);
  return { sheetName, rows, hi, col, cityCols };
}

const isTotalRow = (name: string) => /^(total|subtotal|jumlah|grand total)/i.test(name);

function linesOfSheet(sheet: Columns): FamiliarityInputLine[] {
  const out: FamiliarityInputLine[] = [];
  for (const row of sheet.rows.slice(sheet.hi + 1)) {
    const name = text(row[sheet.col.name]);
    if (!name || isTotalRow(name)) continue;
    // No separate ceiling column is needed for familiarity: prices always
    // come from the item a human chooses, never from the client's list.
    const qtyRaw = sheet.col.qty >= 0 ? toNum(row[sheet.col.qty]) : NaN;
    const qty = Number.isFinite(qtyRaw) && qtyRaw >= 0 ? qtyRaw : undefined;
    const unit = sheet.col.uom >= 0 ? text(row[sheet.col.uom]).slice(0, 32) : "";
    const code = sheet.col.code >= 0 ? text(row[sheet.col.code]).slice(0, 64) : "";
    out.push({
      text: name.slice(0, 300),
      ...(code ? { code } : {}),
      ...(qty === undefined ? {} : { qty }),
      ...(unit ? { unit } : {}),
    });
  }
  return out;
}

function workbookOf(file: FamiliarityFile, data: ArrayBuffer | string): XLSX.WorkBook {
  if (typeof data === "string") {
    /* CSV as raw text: guessing would read the Indonesian thousand separator
       in "32.474" as a decimal point. Real .xlsx cells stay native numbers. */
    return XLSX.read(data, { type: "string", raw: true });
  }
  return XLSX.read(data, { type: "array" });
}

/** Every sheet with an item header, main sheet first. */
export async function parseFamiliarityFile(file: FamiliarityFile): Promise<{ lines: FamiliarityInputLine[]; report: FamiliarityParseReport }> {
  const csv = /\.csv$/i.test(file.name) || file.type === "text/csv";
  const wb = workbookOf(file, csv ? await file.text() : await file.arrayBuffer());
  if (!wb.SheetNames.length) throw new Error("File tidak punya sheet yang bisa dibaca.");

  const main = pickClientSheet(wb);
  const found = [main, ...wb.SheetNames.filter((n) => n !== main)].map((n) => readClientColumns(wb, n));
  // A cover sheet before the real list must not hide it: keep every sheet that
  // has an item header (main sheet first) and only complain when none does.
  const sheets = found.filter((s): s is Columns => !("error" in s));
  if (!sheets.length) {
    throw new Error("error" in found[0] ? found[0].error : "Kolom nama item tidak ditemukan di baris judul.");
  }

  const lines = sheets.flatMap(linesOfSheet);
  if (!lines.length) throw new Error("Tidak ada baris item yang terbaca. Pastikan ada kolom nama item.");

  return {
    lines,
    report: {
      sheets: sheets.map((s) => s.sheetName),
      count: lines.length,
      notes: sheets.length > 1 ? [`Dibaca ${sheets.length} sheet: ${sheets.map((s) => s.sheetName).join(", ")}.`] : [],
    },
  };
}

/**
 * Raw JSON/multipart lines: trim, collapse whitespace, default nothing.
 * A leading list number ("1. Pensil") is dropped, not treated as a code.
 */
export function cleanInputLine(line: FamiliarityInputLine): FamiliarityInputLine {
  let t = String(line.text ?? "").replace(/\s+/g, " ").trim();
  t = t.replace(/^\d{1,3}[).]\s+/, "");
  const qty = Number(line.qty);
  const unit = String(line.unit ?? "").replace(/\s+/g, " ").trim().slice(0, 32);
  const code = String(line.code ?? "").replace(/\s+/g, " ").trim().slice(0, 64);
  return {
    text: t.slice(0, 300),
    ...(Number.isFinite(qty) && qty >= 0 ? { qty } : {}),
    ...(unit ? { unit } : {}),
    ...(code ? { code } : {}),
  };
}

/**
 * Split the code column the client glued into the text ("100591 CAFE_GARAM
 * 1 KG") — but only when `isKnownCode` says the first token is a real catalog
 * or pending code. A product name that starts with a size ("A4 Kertas") is
 * left alone.
 */
export function splitLeadingCode(line: FamiliarityInputLine, isKnownCode: (code: string) => boolean): FamiliarityInputLine {
  if (line.code) return line;
  const m = /^(\S+)\s+(.+)$/.exec(line.text);
  if (!m) return line;
  if (!isKnownCode(m[1])) return line;
  return { ...line, code: m[1], text: m[2] };
}
