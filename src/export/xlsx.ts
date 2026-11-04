/* Exports the full working file: the client-facing lines plus the internal
   margin analysis, assumptions, logistics and scenario comparison. */

import * as XLSX from "xlsx";
import { SCENARIOS } from "@shared/engine";
import { paymentLabel, warrantyLabel } from "@shared/terms";
import { heldNote, holdInfo, offeredRows } from "@shared/holds";
import { DOC_COLUMN_LABELS, docCell, docLayout } from "@shared/docColumns";
import type { Assumptions, DocColumnKey, DocTemplate, EngineResult, QuoteMeta, ScenarioIndex } from "@shared/types";

interface Input {
  engine: EngineResult;
  meta: QuoteMeta;
  /** The client's document template for the "Penawaran" sheet (shared/docColumns.ts). */
  template?: DocTemplate | null;
  assumptions: Assumptions;
  scenario: ScenarioIndex;
  number: string;
  title: string;
  clientName: string;
}

const money = "#,##0";
const percent = "0.0%";

function applyFormat(sheet: XLSX.WorkSheet, columns: Record<string, string>): void {
  const range = XLSX.utils.decode_range(sheet["!ref"] || "A1");
  for (let r = range.s.r + 1; r <= range.e.r; r++) {
    for (const [col, fmt] of Object.entries(columns)) {
      const cell = sheet[`${col}${r + 1}`];
      if (cell && typeof cell.v === "number") cell.z = fmt;
    }
  }
}

export function quoteWorkbook(input: Input): XLSX.WorkBook {
  const { engine, meta, assumptions, scenario, number, title, clientName } = input;
  const wb = XLSX.utils.book_new();

  /* Client-facing sheet */
  const layout = docLayout(meta, input.template, "sheet");
  const quoteRows: Record<string, unknown>[] = offeredRows(engine.rows).map((r) =>
    Object.fromEntries(layout.columns.map((c) => {
      const v = docCell(c.key, r, r.prices[scenario]);
      return [c.label, c.key === "price" || c.key === "total" ? Math.round(v as number) : v];
    })),
  );
  // The totals and footer rows go under the columns, found by key, so a
  // template's headings carry them. Terms sit under the price when a template
  // has no Satuan; totals without a total column get one, as with hideLineTotal.
  const at = (key: DocColumnKey) => layout.columns.find((c) => c.key === key)?.label;
  const L = {
    item: at("name") ?? DOC_COLUMN_LABELS.name,
    uom: at("uom") ?? at("price") ?? DOC_COLUMN_LABELS.uom,
    price: at("price") ?? DOC_COLUMN_LABELS.price,
    total: at("total") ?? DOC_COLUMN_LABELS.total,
  };
  const s = engine.scen[scenario];
  quoteRows.push(
    ...(layout.totals
      ? [
          {},
          { [L.item]: "Subtotal per bulan", [L.total]: Math.round(s.revenue) },
          { [L.item]: `PPN ${(assumptions.ppn * 100).toFixed(0)}%`, [L.total]: Math.round(s.revenue * assumptions.ppn) },
          { [L.item]: "Total per bulan termasuk PPN", [L.total]: Math.round(s.revenue * (1 + assumptions.ppn)) },
          { [L.item]: `Nilai kontrak ${assumptions.months} bulan (belum PPN)`, [L.total]: Math.round(s.annual) },
        ]
      : []),
    {},
    ...(heldNote(engine.rows) ? [{ [L.item]: "Item menyusul", [L.uom]: heldNote(engine.rows) }] : []),
    { [L.item]: "Term of payment", [L.uom]: paymentLabel(meta) || "—" },
    { [L.item]: "Garansi", [L.uom]: warrantyLabel(meta) || "—" },
    { [L.item]: "Masa berlaku penawaran", [L.uom]: `${meta.validity} hari` },
    ...(layout.closing ? [{}, { [L.item]: layout.closing }] : []),
    {},
    { [L.item]: "Hormat kami,", [L.price]: "Disetujui oleh," },
    { [L.item]: "PT Salvator Inti Pratama", [L.price]: clientName },
    {},
    {},
    {},
    { [L.item]: `(${meta.preparedBy || "Nama"})`, [L.price]: "Nama & jabatan: ______________" },
    { [L.price]: "Tanggal: ______________" },
  );
  // A template's title and opening text go above the table; the standard sheet starts with the header row.
  const headerRow = input.template ? (layout.opening ? 3 : 2) : 0;
  const quoteSheet = XLSX.utils.aoa_to_sheet(input.template ? [[layout.title], ...(layout.opening ? [[layout.opening]] : [])] : []);
  XLSX.utils.sheet_add_json(quoteSheet, quoteRows, { origin: { r: headerRow, c: 0 } });
  // Hidden columns are absent, not blank, so the letters shift left: widths and formats follow the header row.
  const WIDTH: Record<DocColumnKey, number> = { no: 5, code: 14, name: 46, uom: 8, qty: 10, price: 14, total: 16, notes: 30 };
  const heads = (XLSX.utils.sheet_to_json(quoteSheet, { header: 1, range: headerRow })[0] ?? []) as string[];
  quoteSheet["!cols"] = heads.map((h) => ({ wch: WIDTH[layout.columns.find((c) => c.label === h)?.key ?? "total"] }));
  const moneyHeads = new Set([at("qty"), at("price"), L.total]);
  applyFormat(quoteSheet, Object.fromEntries(
    heads.flatMap((h, i) => (moneyHeads.has(h) ? [[XLSX.utils.encode_col(i), money]] : [])),
  ));
  XLSX.utils.book_append_sheet(wb, quoteSheet, "Penawaran");

  /* Internal analysis */
  const analysis = engine.rows.map((r) => ({
    No: r.lineNo,
    Ditahan: r.held ? holdInfo(r.holdReason).sheet : "",
    Item: r.name,
    Satuan: r.uom,
    Qty: r.qty,
    COGS: Math.round(r.cogs),
    "COGS estimasi": r.estCogs ? "YA" : "",
    "Landed cost": Math.round(r.landed),
    RRP: Math.round(r.rrp),
    Role: r.role,
    "S1 harga": Math.round(r.prices[0]),
    "S1 margin": r.margins[0],
    "S1 status": r.status[0],
    "S2 harga": Math.round(r.prices[1]),
    "S2 margin": r.margins[1],
    "S2 status": r.status[1],
    "S3 harga": Math.round(r.prices[2]),
    "S3 margin": r.margins[2],
    "S3 status": r.status[2],
    "Nilai terpilih/bln": Math.round(r.qty * r.prices[scenario]),
  }));
  const analysisSheet = XLSX.utils.json_to_sheet(analysis);
  analysisSheet["!cols"] = [{ wch: 5 }, { wch: 42 }, ...Array(17).fill({ wch: 12 })];
  applyFormat(analysisSheet, {
    E: money, G: money, H: money, J: money, K: percent,
    M: money, N: percent, P: money, Q: percent, S: money,
  });
  XLSX.utils.book_append_sheet(wb, analysisSheet, "Analisis Internal");

  /* Scenario comparison */
  const compare = SCENARIOS.map((sc, i) => {
    const x = engine.scen[i];
    return {
      Skenario: `${sc.key} ${sc.name}`,
      Aturan: sc.rule,
      "Revenue/bln": Math.round(x.revenue),
      "Landed cost/bln": Math.round(x.landed),
      "Profit/bln": Math.round(x.profit),
      "Net margin": x.margin,
      "Nilai kontrak": Math.round(x.annual),
      "Hemat klien": x.savingsPct,
      "Hemat item leader": x.leaderSavingsPct,
      "Item di plafon": x.atCeiling,
      "Margin terendah": x.lowestMargin,
      "Item di bawah modal": x.belowCost,
      Terpilih: i === scenario ? "YA" : "",
    };
  });
  const compareSheet = XLSX.utils.json_to_sheet(compare);
  compareSheet["!cols"] = [{ wch: 22 }, { wch: 52 }, ...Array(11).fill({ wch: 14 })];
  applyFormat(compareSheet, {
    C: money, D: money, E: money, F: percent, G: money, H: percent, I: percent, K: percent,
  });
  XLSX.utils.book_append_sheet(wb, compareSheet, "Perbandingan");

  /* Assumptions and logistics */
  const info = [
    ["Quotation", number],
    ["Judul", title],
    ["Klien", clientName],
    ["Tanggal", meta.date],
    ["Skenario terpilih", `${SCENARIOS[scenario].key} ${SCENARIOS[scenario].name}`],
    ["", ""],
    ["ASUMSI", ""],
    ["Opex", assumptions.opex],
    ["Target margin", assumptions.targetMargin],
    ["Margin leader (S2)", assumptions.leaderMargin],
    ["Diskon item profit (S2)", assumptions.profitDiscount],
    ["Diskon dari RRP (S3)", assumptions.rrpDiscount],
    ["Margin minimum (S3)", assumptions.marginFloor],
    ["PPN", assumptions.ppn],
    ["Pembulatan harga", assumptions.step],
    ["Durasi kontrak (bulan)", assumptions.months],
    ["Logistik masuk harga", assumptions.includeLogistics ? "YA" : "TIDAK"],
    ["Blended logistik", engine.blended],
    ["", ""],
    ["LOGISTIK PER REGION", ""],
    ["Region", "Share|Kirim/bln|Biaya/kirim|Biaya/bln|Modifier"],
    ...engine.regions.map((r) => [
      r.name,
      `${(r.share * 100).toFixed(0)}%|${r.deliveries}|${Math.round(r.cost)}|${Math.round(r.monthlyCost)}|${(r.modifier * 100).toFixed(2)}%`,
    ]),
  ];
  const infoSheet = XLSX.utils.aoa_to_sheet(info);
  infoSheet["!cols"] = [{ wch: 30 }, { wch: 54 }];
  XLSX.utils.book_append_sheet(wb, infoSheet, "Asumsi");

  return wb;
}

export function downloadQuoteWorkbook(input: Input): void {
  const safe = (input.number || "quotation").replace(/[^\w-]+/g, "-");
  XLSX.writeFile(quoteWorkbook(input), `${safe}.xlsx`);
}
