/* The Excel a manager sends to sales to check a priced quote (PE-2,
   meeting 2026-10-05 #2; Ryoma 2026-10-06: full detail including COGS,
   locked with the office password, "Tolak" goes back to the manager).

   Every line shows how its price came out (shared/breakdown.ts, the same
   steps the Rincian tab shows, which land exactly on the engine's price).
   Only the ACC/Tolak and Alasan cells are unlocked.

   The sheet password only keeps honest people from editing by accident; it
   is easy to strip. The real control is the import: the app reads back
   nothing but the line ids, decisions and reasons, and the server checks
   them against the quote as it is now (rev and version from the seal).
   Changing a price in the file changes nothing. */

import ExcelJS from "exceljs";
import { SCENARIOS } from "@shared/engine";
import { explainLine, explainQuote } from "@shared/breakdown";
import { paymentLabel, warrantyLabel } from "@shared/terms";
import type { Assumptions, EngineResult, PricingPolicy, QuoteMeta, ScenarioIndex } from "@shared/types";

export interface SalesReviewInput {
  engine: EngineResult;
  meta: QuoteMeta;
  assumptions: Assumptions;
  scenario: ScenarioIndex;
  policy?: PricingPolicy;
  quoteId: number;
  number: string;
  title: string;
  clientName: string;
  revNo: number;
  version: number;
  password: string;
}

export const SHEET = "Cek Harga";
export const SEAL = "_segel";
const HEAD_ROW = 4;

/** Column letter -> header; A (line id) is hidden. */
export const COLUMNS = {
  id: "A", no: "B", code: "C", item: "D", uom: "E", qty: "F", cogs: "G", landed: "H", rrp: "I",
  price: "J", margin: "K", total: "L", how: "M", notes: "N", decision: "O", reason: "P",
} as const;

const HEADERS: [keyof typeof COLUMNS, string, number][] = [
  ["id", "id", 10],
  ["no", "No", 5],
  ["code", "Kode", 12],
  ["item", "Item", 34],
  ["uom", "Satuan", 8],
  ["qty", "Qty", 8],
  ["cogs", "COGS", 12],
  ["landed", "Landed cost", 12],
  ["rrp", "Plafon RRP", 12],
  ["price", "Harga", 12],
  ["margin", "Margin", 8],
  ["total", "Total/bulan", 14],
  ["how", "Cara harga keluar", 70],
  ["notes", "Perlu dilihat", 26],
  ["decision", "ACC / Tolak", 12],
  ["reason", "Alasan (wajib kalau Tolak)", 32],
];

const MONEY = "#,##0";
const PERCENT = "0.0%";
const FILL_INPUT: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF3C4" } };
const FILL_HEAD: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8F0F7" } };
const FILL_HELD: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF0F0F0" } };
const HELD = "DITAHAN";

export async function salesReviewWorkbook(input: SalesReviewInput): Promise<ExcelJS.Workbook> {
  const { engine, meta, assumptions: a, scenario: k, policy } = input;
  const sc = SCENARIOS[k];
  const wb = new ExcelJS.Workbook();
  wb.creator = "Pricing Engine Salvator";

  /* ---------- Cek Harga ---------- */
  const ws = wb.addWorksheet(SHEET, { views: [{ state: "frozen", ySplit: HEAD_ROW, xSplit: 4 }] });
  ws.getCell("B1").value = `Cek harga ${input.number} · ${input.clientName || "tanpa klien"} · ${sc.key} ${sc.name} · revisi ${input.revNo}`;
  ws.getCell("B1").font = { bold: true, size: 13 };
  ws.getCell("B2").value =
    "Isi kolom kuning saja: ACC kalau harga baris itu oke, Tolak kalau tidak (tulis alasannya). " +
    "Semua baris harus diisi. Upload balik file ini di halaman quotation lewat \"Import hasil cek sales\".";
  ws.getCell("B2").font = { italic: true, color: { argb: "FF555555" } };

  HEADERS.forEach(([key, label, width]) => {
    const col = ws.getColumn(COLUMNS[key]);
    col.width = width;
    const cell = ws.getCell(`${COLUMNS[key]}${HEAD_ROW}`);
    cell.value = label;
    cell.font = { bold: true };
    cell.fill = key === "decision" || key === "reason" ? FILL_INPUT : FILL_HEAD;
    cell.alignment = { vertical: "middle", wrapText: true };
  });
  ws.getColumn(COLUMNS.id).hidden = true;

  let r = HEAD_ROW;
  for (const row of engine.rows) {
    r += 1;
    const ex = explainLine(row, k, a, engine, policy);
    const held = !!row.held;
    const values: Partial<Record<keyof typeof COLUMNS, ExcelJS.CellValue>> = {
      id: row.id,
      no: row.lineNo,
      code: row.code,
      item: row.name,
      uom: row.uom,
      qty: row.qty,
      cogs: Math.round(row.cogs),
      landed: Math.round(row.landed),
      rrp: Math.round(row.rrp),
      price: held ? null : row.prices[k],
      margin: held ? null : row.margins[k],
      total: held ? null : Math.round(row.prices[k] * row.qty),
      how: held
        ? row.holdReason === "sales"
          ? "Menyusul: ditolak di cek sebelumnya, ada di Perlu diperbaiki. Baris ini tidak ikut penawaran dan tidak perlu dicek."
          : "Ditahan: COGS di katalog perlu dicek manajer. Baris ini tidak ikut penawaran dan tidak perlu dicek."
        : ex.steps.map((s, i) => `${i + 1}. ${s}`).join("\n"),
      notes: ex.flags.join("; "),
      decision: held ? HELD : null,
      reason: null,
    };
    for (const [key, value] of Object.entries(values)) {
      ws.getCell(`${COLUMNS[key as keyof typeof COLUMNS]}${r}`).value = value ?? null;
    }
    for (const key of ["qty", "cogs", "landed", "rrp", "price", "total"] as const) {
      ws.getCell(`${COLUMNS[key]}${r}`).numFmt = MONEY;
    }
    ws.getCell(`${COLUMNS.margin}${r}`).numFmt = PERCENT;
    ws.getRow(r).alignment = { vertical: "top", wrapText: true };
    if (held) {
      ws.getRow(r).eachCell({ includeEmpty: true }, (c) => (c.fill = FILL_HELD));
    } else {
      for (const key of ["decision", "reason"] as const) {
        const c = ws.getCell(`${COLUMNS[key]}${r}`);
        c.protection = { locked: false };
        c.fill = FILL_INPUT;
      }
      ws.getCell(`${COLUMNS.decision}${r}`).dataValidation = {
        type: "list",
        allowBlank: true,
        formulae: ['"ACC,Tolak"'],
        showErrorMessage: true,
        errorTitle: "ACC atau Tolak",
        error: "Pilih ACC atau Tolak.",
      };
    }
  }

  const s = engine.scen[k];
  r += 2;
  ws.getCell(`${COLUMNS.item}${r}`).value = "Total per bulan (belum PPN)";
  ws.getCell(`${COLUMNS.total}${r}`).value = Math.round(s.revenue);
  ws.getCell(`${COLUMNS.item}${r + 1}`).value = "Net margin";
  ws.getCell(`${COLUMNS.total}${r + 1}`).value = s.margin;
  ws.getCell(`${COLUMNS.total}${r}`).numFmt = MONEY;
  ws.getCell(`${COLUMNS.total}${r + 1}`).numFmt = PERCENT;
  for (const rr of [r, r + 1]) ws.getRow(rr).font = { bold: true };

  await ws.protect(input.password, {
    selectLockedCells: true,
    selectUnlockedCells: true,
    formatColumns: true,
    formatRows: true,
  });

  /* ---------- Ringkasan ---------- */
  const sum = wb.addWorksheet("Ringkasan");
  const bd = explainQuote(engine, k, a, policy);
  const lines: [string, ExcelJS.CellValue, string?][] = [
    ["Quotation", `${input.number} — ${input.title}`],
    ["Klien", input.clientName || "—"],
    ["Revisi", input.revNo],
    ["Skenario", `${sc.key} ${sc.name}`],
    ["", ""],
    ["Ringkasan", bd.headline],
    ...bd.points.map((p): [string, string] => ["", p]),
    ["", ""],
    ["Total per bulan (belum PPN)", Math.round(s.revenue), MONEY],
    [`PPN ${(a.ppn * 100).toFixed(0)}%`, Math.round(s.revenue * a.ppn), MONEY],
    [`Nilai kontrak ${a.months} bulan`, Math.round(s.annual), MONEY],
    ["Laba per bulan", Math.round(s.profit), MONEY],
    ["Net margin", s.margin, PERCENT],
    ["", ""],
    ["ASUMSI", ""],
    ["Opex", a.opex, PERCENT],
    ["Logistik masuk harga", a.includeLogistics ? `Ya (${(engine.logiApplied * 100).toFixed(2)}%)` : "Tidak"],
    ["Target margin (S1)", a.targetMargin, PERCENT],
    ["Margin leader (S2)", a.leaderMargin, PERCENT],
    ["Diskon item profit (S2)", a.profitDiscount, PERCENT],
    ["Diskon dari RRP (S3)", a.rrpDiscount, PERCENT],
    ["Margin minimum (S3)", a.marginFloor, PERCENT],
    ["Pembulatan harga", a.step, MONEY],
    ["", ""],
    ["Term of payment", paymentLabel(meta) || "—"],
    ["Garansi", warrantyLabel(meta) || "—"],
  ];
  sum.getColumn(1).width = 30;
  sum.getColumn(2).width = 100;
  lines.forEach(([label, value, fmt], i) => {
    const row = sum.getRow(i + 1);
    row.getCell(1).value = label;
    row.getCell(1).font = { bold: true };
    row.getCell(2).value = value;
    row.getCell(2).alignment = { wrapText: true, horizontal: "left" };
    if (fmt) row.getCell(2).numFmt = fmt;
  });
  await sum.protect(input.password, { selectLockedCells: true, selectUnlockedCells: true });

  /* ---------- seal: which quote, which revision, which version ---------- */
  const seal = wb.addWorksheet(SEAL, { state: "veryHidden" });
  seal.addRows([
    ["quote_id", input.quoteId],
    ["number", input.number],
    ["rev_no", input.revNo],
    ["version", input.version],
    ["scenario", k],
    ["exported_at", new Date().toISOString()],
  ]);
  await seal.protect(input.password, {});

  return wb;
}

export async function downloadSalesReview(input: SalesReviewInput): Promise<void> {
  const wb = await salesReviewWorkbook(input);
  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `Cek-harga-${(input.number || "quotation").replace(/[^\w-]+/g, "-")}-rev${input.revNo}.xlsx`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ---------------- reading the file back ---------------- */

export type Decision = "acc" | "tolak";

export interface ReadReview {
  quoteId: number;
  revNo: number;
  version: number;
  lines: { id: string; lineNo: number; name: string; decision: Decision | null; reason: string }[];
  /** Lines with something other than ACC/Tolak in the decision cell (typed by hand). */
  invalid: { lineNo: number; name: string; value: string }[];
}

const text = (v: ExcelJS.CellValue): string => {
  if (v == null) return "";
  if (typeof v === "object" && "richText" in v) return v.richText.map((t) => t.text).join("");
  if (typeof v === "object" && "text" in v) return String(v.text);
  if (typeof v === "object" && "result" in v) return String(v.result ?? "");
  return String(v);
};

/** Reads only ids, decisions and reasons. Prices in the file are never read. */
export async function readSalesReview(data: ArrayBuffer): Promise<ReadReview> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(data);
  } catch {
    throw new Error("File ini bukan Excel yang bisa dibaca.");
  }
  const ws = wb.getWorksheet(SHEET);
  const seal = wb.getWorksheet(SEAL);
  if (!ws || !seal) throw new Error("Ini bukan file \"Cek harga\" dari aplikasi. Unduh file cek harga dari halaman quotation.");
  const sealed = new Map<string, string>();
  seal.eachRow((row) => sealed.set(text(row.getCell(1).value), text(row.getCell(2).value)));
  const num = (key: string) => {
    const n = Number(sealed.get(key));
    if (!Number.isInteger(n)) throw new Error("Segel file rusak. Unduh ulang file cek harga.");
    return n;
  };

  const lines: ReadReview["lines"] = [];
  const invalid: ReadReview["invalid"] = [];
  ws.eachRow((row, i) => {
    if (i <= HEAD_ROW) return;
    const id = text(row.getCell(COLUMNS.id).value).trim();
    if (!id) return;
    const raw = text(row.getCell(COLUMNS.decision).value).trim();
    if (raw === HELD) return;
    const lineNo = Number(text(row.getCell(COLUMNS.no).value)) || 0;
    const name = text(row.getCell(COLUMNS.item).value);
    const lower = raw.toLowerCase();
    const decision: Decision | null = lower === "acc" ? "acc" : lower === "tolak" ? "tolak" : null;
    if (raw && !decision) invalid.push({ lineNo, name, value: raw });
    lines.push({ id, lineNo, name, decision, reason: text(row.getCell(COLUMNS.reason).value).trim() });
  });
  return { quoteId: num("quote_id"), revNo: num("rev_no"), version: num("version"), lines, invalid };
}
