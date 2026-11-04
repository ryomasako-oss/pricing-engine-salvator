/* Generates the client-facing quotation as a real PDF file, so a rep can
   attach it to an email without going through the browser print dialog. */

import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { SCENARIOS } from "@shared/engine";
import { shownCode } from "@shared/pendingItems";
import { fmtDate, grp, pct } from "@shared/format";
import type { Assumptions, ComputedRow, DocColumnKey, DocTemplate, EngineResult, QuoteMeta, ScenarioIndex } from "@shared/types";
import type { CompanyInfo } from "../components/QuotationDoc";
import { paymentLabel, warrantyLabel } from "@shared/terms";
import { heldNote, offeredRows } from "@shared/holds";
import { docCell, docLayout } from "@shared/docColumns";

interface Input {
  engine: EngineResult;
  meta: QuoteMeta;
  assumptions: Assumptions;
  scenario: ScenarioIndex;
  company: CompanyInfo;
  clientName: string;
  clientAddress?: string;
  /** The client's document template (shared/docColumns.ts); absent prints the standard document. */
  template?: DocTemplate | null;
  number: string;
  draft: boolean;
}

const NAVY: [number, number, number] = [31, 58, 95];
const MUTED: [number, number, number] = [102, 115, 132];

export function quotationPdf(input: Input): jsPDF {
  const { engine, meta, assumptions, scenario, company, clientName, number, draft } = input;
  const s = engine.scen[scenario];
  const layout = docLayout(meta, input.template, "print");
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const W = doc.internal.pageSize.getWidth();
  const M = 40;

  let headerBottom = 56;
  if (company.logo) {
    const format = company.logo.startsWith("data:image/png") ? "PNG" : company.logo.startsWith("data:image/webp") ? "WEBP" : "JPEG";
    const { width, height } = doc.getImageProperties(company.logo);
    const maxW = 140;
    const maxH = 40;
    const scale = Math.min(maxW / width, maxH / height, 1);
    const w = width * scale;
    const h = height * scale;
    doc.addImage(company.logo, format, M, 24, w, h);
    headerBottom = 24 + h;
  } else {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(20);
    doc.setTextColor(...NAVY);
    doc.text(company.brand, M, 56);
  }

  doc.setFont("helvetica", "normal");
  doc.setFontSize(8.5);
  doc.setTextColor(...MUTED);
  const companyLines = [
    company.name + (company.tagline ? `, ${company.tagline}` : ""),
    company.address,
    [company.phone, company.email].filter(Boolean).join(" · "),
  ].filter(Boolean);
  companyLines.forEach((line, i) => doc.text(line, M, headerBottom + 14 + i * 11));

  doc.setFont("helvetica", "bold");
  doc.setFontSize(15);
  doc.setTextColor(30, 37, 48);
  // A tender title can be long: wrapped on the right half so it never runs into the logo or off the page.
  const titleLines = doc.splitTextToSize(layout.title.toUpperCase(), W / 2 - M) as string[];
  titleLines.forEach((line, i) => doc.text(line, W - M, 56 + i * 17, { align: "right" }));
  let titleBottom = 56 + (titleLines.length - 1) * 17;
  if (draft) {
    doc.setFontSize(9);
    doc.setTextColor(180, 35, 24);
    doc.text("DRAFT — belum disetujui", W - M, titleBottom + 14, { align: "right" });
    titleBottom += 14;
  }

  // Only a wrapped title can push the client block down; a one-line title leaves it where it always was.
  const companyBottom = headerBottom + 14 + companyLines.length * 11 + 14;
  const top = titleLines.length > 1 ? Math.max(companyBottom, titleBottom + 14) : companyBottom;
  doc.setDrawColor(220, 226, 232);
  doc.line(M, top, W - M, top);

  const validUntil = new Date(new Date(meta.date).getTime() + (meta.validity || 30) * 86400000);
  autoTable(doc, {
    startY: top + 12,
    theme: "plain",
    styles: { fontSize: 9, cellPadding: 2 },
    columnStyles: {
      0: { cellWidth: 78, textColor: MUTED },
      1: { cellWidth: 180, fontStyle: "bold" },
      2: { cellWidth: 78, textColor: MUTED },
      3: { fontStyle: "bold" },
    },
    body: [
      ["Kepada", clientName, "Nomor", number || meta.quoteNo],
      ["", input.clientAddress || "", "Tanggal", fmtDate(meta.date)],
      ["", "", "Berlaku sampai", fmtDate(validUntil)],
      ["", "", "Term of payment", paymentLabel(meta) || "—"],
      ["", "", "Garansi", warrantyLabel(meta) || "—"],
      ["", "", "Disiapkan oleh", meta.preparedBy || ""],
    ],
  });

  let tableY = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 14;
  if (layout.opening) {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(30, 37, 48);
    const lines = doc.splitTextToSize(layout.opening, W - M * 2) as string[];
    doc.text(lines, M, tableY + 4);
    tableY += lines.length * 11 + 6;
  }

  // Each column keeps its own style, looked up by key: a style table keyed by
  // column index would put the right-align and bold on the wrong column as
  // soon as one is dropped or a client template reorders them.
  const STYLE: Record<DocColumnKey, Record<string, unknown>> = {
    no: { halign: "center", cellWidth: 26 },
    code: { cellWidth: 58 },
    name: {},
    uom: { halign: "center", cellWidth: 48 },
    qty: { halign: "right", cellWidth: 58 },
    price: { halign: "right", cellWidth: 76, fontStyle: "bold" },
    total: { halign: "right", cellWidth: 84 },
    // Auto width, shared with the item name, so a template using every column still leaves the name room.
    notes: {},
  };
  const cell = (key: DocColumnKey, r: ComputedRow): string => {
    if (key === "name" && layout.codeUnderName && shownCode(r.code)) return `${r.name}\n${shownCode(r.code)}`;
    const v = docCell(key, r, r.prices[scenario]);
    return typeof v === "number" && key !== "no" ? grp(v) : String(v);
  };
  const columns = layout.columns;
  autoTable(doc, {
    startY: tableY,
    head: [columns.map((c) => c.label)],
    body: offeredRows(engine.rows).map((r) => columns.map((c) => cell(c.key, r))),
    styles: { fontSize: 8.5, cellPadding: 4, lineColor: [238, 241, 244], lineWidth: 0.5 },
    headStyles: { fillColor: [246, 248, 250], textColor: [27, 37, 48], fontStyle: "bold" },
    columnStyles: Object.fromEntries(columns.map((c, i) => [i, STYLE[c.key]])),
    margin: { left: M, right: M },
  });

  const ppn = s.revenue * assumptions.ppn;
  if (layout.totals) autoTable(doc, {
    startY: (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 10,
    // Keep the totals together: a subtotal stranded alone at the foot of a
    // page reads as a mistake on a document going to a client.
    pageBreak: "avoid",
    theme: "plain",
    styles: { fontSize: 9.5, cellPadding: 3 },
    columnStyles: { 0: { halign: "right", cellWidth: 260 }, 1: { halign: "right", cellWidth: 112, fontStyle: "bold" } },
    margin: { left: W - M - 372, right: M },
    body: [
      ["Subtotal per bulan", "Rp " + grp(s.revenue)],
      [`PPN ${pct(assumptions.ppn, 0)}`, "Rp " + grp(ppn)],
      ["Total per bulan", "Rp " + grp(s.revenue + ppn)],
      [`Nilai kontrak ${assumptions.months} bulan (belum PPN)`, "Rp " + grp(s.annual)],
    ],
    didParseCell: (data) => {
      if (data.row.index === 2) data.cell.styles.fontStyle = "bold";
    },
  });

  let y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 18;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.setTextColor(...MUTED);
  const terms = doc.splitTextToSize(
    `Harga dalam Rupiah per satuan dan belum termasuk PPN. ` +
      `Pengiriman ${meta.delivery}. Penawaran berlaku ${meta.validity} hari sejak tanggal di atas.` +
      (company.bank ? ` Pembayaran ke ${company.bank}.` : "") +
      (company.npwp ? ` NPWP ${company.npwp}.` : ""),
    W - M * 2,
  ) as string[];
  doc.text(terms, M, y);
  y += terms.length * 10;

  const following = heldNote(engine.rows);
  if (following) {
    const lines = doc.splitTextToSize(`Item menyusul: ${following}`, W - M * 2) as string[];
    doc.text(lines, M, y + 6);
    y += lines.length * 10 + 6;
  }

  if (meta.notes) {
    const notes = doc.splitTextToSize(meta.notes, W - M * 2) as string[];
    doc.text(notes, M, y + 6);
    y += notes.length * 10 + 6;
  }

  if (layout.closing) {
    doc.setFontSize(9);
    doc.setTextColor(30, 37, 48);
    const lines = doc.splitTextToSize(layout.closing, W - M * 2) as string[];
    doc.text(lines, M, y + 12);
    y += lines.length * 11 + 12;
  }

  // Signature block (meeting 2026-10-05): room for a wet or digital signature
  // on both sides. Kept whole: moved to a new page if it would be cut off.
  const SIGN_H = 120;
  const pageH = doc.internal.pageSize.getHeight();
  y += 22;
  if (y + SIGN_H > pageH - 40) {
    doc.addPage();
    y = 60;
  }
  const colW = (W - M * 2 - 40) / 2;
  const sign = (x: number, lead: string, party: string, lines: string[]) => {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8.5);
    doc.setTextColor(...MUTED);
    doc.text(lead, x, y);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(30, 37, 48);
    doc.text(doc.splitTextToSize(party, colW) as string[], x, y + 12);
    const lineY = y + 84;
    doc.setDrawColor(30, 37, 48);
    doc.line(x, lineY, x + colW * 0.8, lineY);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8.5);
    lines.forEach((l, i) => {
      doc.setTextColor(...(i === 0 ? ([30, 37, 48] as [number, number, number]) : MUTED));
      doc.text(l, x, lineY + 12 + i * 11);
    });
  };
  sign(M, "Hormat kami,", company.name, [meta.preparedBy || "Nama"]);
  sign(M + colW + 40, "Disetujui oleh,", clientName, ["Nama & jabatan:", "Tanggal:"]);
  y += SIGN_H;

  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setFontSize(7.5);
    doc.setTextColor(...MUTED);
    doc.text(
      `${company.name} · ${number || meta.quoteNo} · ${SCENARIOS[scenario].key}`,
      M,
      doc.internal.pageSize.getHeight() - 22,
    );
    doc.text(
      `Halaman ${i} dari ${pages}`,
      W - M,
      doc.internal.pageSize.getHeight() - 22,
      { align: "right" },
    );
  }
  return doc;
}

export function downloadQuotationPdf(input: Input): void {
  const safe = (input.number || input.meta.quoteNo || "quotation").replace(/[^\w-]+/g, "-");
  quotationPdf(input).save(`${safe}.pdf`);
}
