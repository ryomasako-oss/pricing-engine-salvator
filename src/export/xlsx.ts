/* Exports the full working file: the client-facing lines plus the internal
   margin analysis, assumptions, logistics and scenario comparison.

   ExcelJS (not SheetJS) because the client-facing sheet embeds the product
   photos the rep uploaded; SheetJS' community build cannot write images. */

import ExcelJS from "exceljs";
import { SCENARIOS } from "@shared/engine";
import { paymentLabel, warrantyLabel } from "@shared/terms";
import { heldNote, holdInfo, offeredRows } from "@shared/holds";
import { docColumns } from "@shared/docColumns";
import type { Assumptions, EngineResult, QuoteMeta, ScenarioIndex } from "@shared/types";

interface Input {
  engine: EngineResult;
  meta: QuoteMeta;
  assumptions: Assumptions;
  scenario: ScenarioIndex;
  number: string;
  title: string;
  clientName: string;
}

const money = "#,##0";
const percent = "0.0%";
const HEAD_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8F0F7" } };

/** Excel can draw JPEG and PNG; the uploader always produces JPEG. */
function imageExtension(image: string): "jpeg" | "png" | null {
  if (image.startsWith("data:image/png")) return "png";
  if (/^data:image\/(jpeg|jpg);/.test(image)) return "jpeg";
  return null;
}

function styleHeader(ws: ExcelJS.Worksheet): void {
  ws.getRow(1).eachCell((cell) => {
    cell.font = { bold: true };
    cell.fill = HEAD_FILL;
    cell.alignment = { vertical: "middle", wrapText: true };
  });
  ws.views = [{ state: "frozen", ySplit: 1 }];
}

function setWidths(ws: ExcelJS.Worksheet, widths: number[]): void {
  widths.forEach((width, i) => {
    ws.getColumn(i + 1).width = width;
  });
}

/** The 1-based column of a header, or 0 when the sheet doesn't show it. */
const columnOf = (header: string[], name: string) => header.indexOf(name) + 1;

function styleMoney(row: ExcelJS.Row, columns: number[]): void {
  for (const column of columns) {
    if (column > 0) row.getCell(column).numFmt = money;
  }
}

function stylePercent(row: ExcelJS.Row, columns: number[]): void {
  for (const column of columns) {
    if (column > 0) row.getCell(column).numFmt = percent;
  }
}

export async function quoteWorkbook(input: Input): Promise<ExcelJS.Workbook> {
  const { engine, meta, assumptions, scenario, number, title, clientName } = input;
  const wb = new ExcelJS.Workbook();
  wb.creator = "Pricing Engine Salvator";

  /* ---------- client-facing sheet ---------- */
  const cols = docColumns(meta);
  const rows = offeredRows(engine.rows);
  const hasPhotos = rows.some((r) => r.image);
  const header = [
    "No",
    ...(hasPhotos ? ["Foto"] : []),
    "Kode",
    "Item",
    "Satuan",
    ...(cols.qty ? ["Qty"] : []),
    "Harga satuan",
    ...(cols.lineTotal ? ["Total per bulan"] : []),
  ];
  const noCol = columnOf(header, "No");
  const photoCol = columnOf(header, "Foto");
  const codeCol = columnOf(header, "Kode");
  const itemCol = columnOf(header, "Item");
  const uomCol = columnOf(header, "Satuan");
  const qtyCol = columnOf(header, "Qty");
  const priceCol = columnOf(header, "Harga satuan");
  const lineTotalCol = columnOf(header, "Total per bulan");
  // Without a visible line-total column the totals block still needs a value
  // column, exactly as the old sheet did: unlabeled, one to the right of price.
  const totalCol = lineTotalCol || priceCol + 1;
  if (!lineTotalCol && cols.totals) header.push("");

  const quoteSheet = wb.addWorksheet("Penawaran");
  quoteSheet.addRow(header);
  styleHeader(quoteSheet);

  const s = engine.scen[scenario];
  const widthFor = (name: string): number =>
    name === "No" ? 5
      : name === "Foto" ? 6
        : name === "Kode" ? 14
          : name === "Item" ? 46
            : name === "Satuan" ? 8
              : name === "Qty" ? 10
                : 14;
  setWidths(quoteSheet, header.map((name) => widthFor(name)));
  if (!lineTotalCol && cols.totals) quoteSheet.getColumn(totalCol).width = 16;

  rows.forEach((r) => {
    const values = new Array(header.length).fill(null) as ExcelJS.CellValue[];
    values[noCol - 1] = r.lineNo;
    values[codeCol - 1] = r.code;
    values[itemCol - 1] = r.name;
    values[uomCol - 1] = r.uom;
    if (qtyCol) values[qtyCol - 1] = r.qty;
    values[priceCol - 1] = Math.round(r.prices[scenario]);
    if (lineTotalCol) values[lineTotalCol - 1] = Math.round(r.prices[scenario] * r.qty);

    const row = quoteSheet.addRow(values);
    if (hasPhotos) row.height = 32;
    styleMoney(row, [qtyCol, priceCol, lineTotalCol].filter(Boolean));

    if (hasPhotos && r.image) {
      const extension = imageExtension(r.image);
      if (extension) {
        // Thumbnail only: the photo is already compressed to a small data URL.
        const imageId = wb.addImage({ base64: r.image, extension });
        quoteSheet.addImage(imageId, {
          tl: { col: photoCol - 1 + 0.08, row: row.number - 1 + 0.06 },
          ext: { width: 30, height: 30 },
          editAs: "oneCell",
        });
      }
    }
  });

  if (cols.totals) {
    quoteSheet.addRow([]);
    const totals: [string, number][] = [
      ["Subtotal per bulan", s.revenue],
      [`PPN ${(assumptions.ppn * 100).toFixed(0)}%`, s.revenue * assumptions.ppn],
      ["Total per bulan termasuk PPN", s.revenue * (1 + assumptions.ppn)],
      [`Nilai kontrak ${assumptions.months} bulan (belum PPN)`, s.annual],
    ];
    for (const [label, value] of totals) {
      const values = new Array(header.length).fill(null) as ExcelJS.CellValue[];
      values[itemCol - 1] = label;
      values[totalCol - 1] = Math.round(value);
      const row = quoteSheet.addRow(values);
      row.getCell(totalCol).numFmt = money;
      if (label === "Total per bulan termasuk PPN") row.font = { bold: true };
    }
  }

  const addTermsRow = (item: string, satuan?: string, price?: string): void => {
    const values = new Array(header.length).fill(null) as ExcelJS.CellValue[];
    values[itemCol - 1] = item;
    if (satuan != null) values[uomCol - 1] = satuan;
    if (price != null) values[priceCol - 1] = price;
    quoteSheet.addRow(values);
  };

  quoteSheet.addRow([]);
  if (heldNote(engine.rows)) addTermsRow("Item menyusul", heldNote(engine.rows));
  addTermsRow("Term of payment", paymentLabel(meta) || "—");
  addTermsRow("Garansi", warrantyLabel(meta) || "—");
  addTermsRow("Masa berlaku penawaran", `${meta.validity} hari`);
  quoteSheet.addRow([]);
  addTermsRow("Hormat kami,", undefined, "Disetujui oleh,");
  addTermsRow("PT Salvator Inti Pratama", undefined, clientName);
  quoteSheet.addRow([]);
  quoteSheet.addRow([]);
  quoteSheet.addRow([]);
  addTermsRow(`(${meta.preparedBy || "Nama"})`, undefined, "Nama & jabatan: ______________");
  addTermsRow("", undefined, "Tanggal: ______________");

  /* ---------- internal margin analysis ---------- */
  const analysisHeader = [
    "No", "Ditahan", "Item", "Satuan", "Qty", "COGS", "COGS estimasi", "Landed cost", "RRP", "Role",
    "S1 harga", "S1 margin", "S1 status", "S2 harga", "S2 margin", "S2 status",
    "S3 harga", "S3 margin", "S3 status", "Nilai terpilih/bln",
  ];
  const analysisSheet = wb.addWorksheet("Analisis Internal");
  analysisSheet.addRow(analysisHeader);
  styleHeader(analysisSheet);
  setWidths(analysisSheet, [5, 22, 42, 10, ...Array(16).fill(12)]);
  for (const r of engine.rows) {
    const row = analysisSheet.addRow([
      r.lineNo,
      r.held ? holdInfo(r.holdReason).sheet : "",
      r.name,
      r.uom,
      r.qty,
      Math.round(r.cogs),
      r.estCogs ? "YA" : "",
      Math.round(r.landed),
      Math.round(r.rrp),
      r.role,
      Math.round(r.prices[0]),
      r.margins[0],
      r.status[0],
      Math.round(r.prices[1]),
      r.margins[1],
      r.status[1],
      Math.round(r.prices[2]),
      r.margins[2],
      r.status[2],
      Math.round(r.qty * r.prices[scenario]),
    ]);
    styleMoney(row, [5, 6, 8, 9, 11, 14, 17, 20]);
    stylePercent(row, [12, 15, 18]);
  }

  /* ---------- scenario comparison ---------- */
  const compareHeader = [
    "Skenario", "Aturan", "Revenue/bln", "Landed cost/bln", "Profit/bln", "Net margin",
    "Nilai kontrak", "Hemat klien", "Hemat item leader", "Item di plafon",
    "Margin terendah", "Item di bawah modal", "Terpilih",
  ];
  const compareSheet = wb.addWorksheet("Perbandingan");
  compareSheet.addRow(compareHeader);
  styleHeader(compareSheet);
  setWidths(compareSheet, [22, 52, ...Array(11).fill(14)]);
  SCENARIOS.forEach((sc, i) => {
    const x = engine.scen[i];
    const row = compareSheet.addRow([
      `${sc.key} ${sc.name}`,
      sc.rule,
      Math.round(x.revenue),
      Math.round(x.landed),
      Math.round(x.profit),
      x.margin,
      Math.round(x.annual),
      x.savingsPct,
      x.leaderSavingsPct,
      x.atCeiling,
      x.lowestMargin,
      x.belowCost,
      i === scenario ? "YA" : "",
    ]);
    styleMoney(row, [3, 4, 5, 7]);
    stylePercent(row, [6, 8, 9, 11]);
  });

  /* ---------- assumptions and logistics ---------- */
  const info: [string, ExcelJS.CellValue][] = [
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
    ...engine.regions.map((r): [string, string] => [
      r.name,
      `${(r.share * 100).toFixed(0)}%|${r.deliveries}|${Math.round(r.cost)}|${Math.round(r.monthlyCost)}|${(r.modifier * 100).toFixed(2)}%`,
    ]),
  ];
  const infoSheet = wb.addWorksheet("Asumsi");
  info.forEach(([label, value]) => {
    const row = infoSheet.addRow([label, value]);
    row.getCell(1).font = { bold: true };
    row.getCell(2).alignment = { wrapText: true };
  });
  setWidths(infoSheet, [30, 54]);

  return wb;
}

export async function downloadQuoteWorkbook(input: Input): Promise<void> {
  const wb = await quoteWorkbook(input);
  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const safe = (input.number || "quotation").replace(/[^\w-]+/g, "-");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${safe}.xlsx`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
