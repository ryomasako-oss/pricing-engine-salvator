/* Generates the client-facing quotation as a real PDF file, so a rep can
   attach it to an email without going through the browser print dialog. */

import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { SCENARIOS } from "@shared/engine";
import { shownCode } from "@shared/pendingItems";
import { fmtDate, grp } from "@shared/format";
import type { Assumptions, ComputedRow, DocColumnKey, DocTemplate, EngineResult, QuoteMeta, ScenarioIndex } from "@shared/types";
import type { CompanyInfo, DocSignature } from "../components/QuotationDoc";
import { DEFAULT_LOGO } from "../assets/defaultLogo";
import { heldNote, offeredRows } from "@shared/holds";
import { docCell, docLayout, docNotes, docTotals } from "@shared/docColumns";
import { loadDocImages } from "./docImages";

interface Input {
  engine: EngineResult;
  meta: QuoteMeta;
  assumptions: Assumptions;
  scenario: ScenarioIndex;
  company: CompanyInfo;
  clientName: string;
  clientAddress?: string;
  clientContact?: string;
  /** Printed only when the caller got one for a final quote (GET /api/quotes/:id/signature). */
  signature?: DocSignature | null;
  /** The client's document template (shared/docColumns.ts); absent prints the standard document. */
  template?: DocTemplate | null;
  /** Item code -> JPEG data URL, for the "Gambar" column (docImages.ts); a code without one is a blank cell. */
  images?: Record<string, string>;
  number: string;
  draft: boolean;
}

const MUTED: [number, number, number] = [102, 115, 132];
const INK: [number, number, number] = [30, 37, 48];

export function quotationPdf(input: Input): jsPDF {
  const { engine, meta, assumptions, scenario, company, clientName, number, draft } = input;
  const s = engine.scen[scenario];
  const layout = docLayout(meta, input.template, "print");
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const W = doc.internal.pageSize.getWidth();
  const M = 40;

  const pageH = doc.internal.pageSize.getHeight();
  /** Room kept at the foot of every page for the letterhead (company name, address, contacts). */
  const FOOT = 64;
  const imageFormat = (src: string) => (src.startsWith("data:image/png") ? "PNG" : src.startsWith("data:image/webp") ? "WEBP" : "JPEG");
  /** Draws an image scaled into a box, keeping its proportions; returns the drawn height. */
  const fit = (src: string, x: number, y: number, maxW: number, maxH: number): number => {
    const { width, height } = doc.getImageProperties(src);
    const k = Math.min(maxW / width, maxH / height, 1);
    doc.addImage(src, imageFormat(src), x, y, width * k, height * k);
    return height * k;
  };
  const text = (size: number, bold = false, color: [number, number, number] = INK) => {
    doc.setFont("helvetica", bold ? "bold" : "normal");
    doc.setFontSize(size);
    doc.setTextColor(...color);
  };

  const logoBottom = 24 + fit(company.logo || DEFAULT_LOGO, M, 24, 120, 70);

  text(9);
  doc.text(`${company.city || "Jakarta"}, ${fmtDate(meta.date)}`, W - M, 40, { align: "right" });
  doc.text(`No. ${number || meta.quoteNo}`, W - M, 52, { align: "right" });
  if (draft) {
    text(9, true, [180, 35, 24]);
    doc.text("DRAFT — belum disetujui", W - M, 66, { align: "right" });
  }

  let y = logoBottom + 20;
  text(9, true);
  doc.text("Kepada Yth.", M, y);
  text(9);
  const toLines = [
    ...(doc.splitTextToSize(clientName, W / 2) as string[]),
    ...(input.clientContact ? [`Up: ${input.clientContact}`] : []),
    ...(input.clientAddress ? (doc.splitTextToSize(input.clientAddress, W / 2) as string[]) : []),
  ];
  doc.text(toLines, M, y + 12);
  y += 12 + toLines.length * 11 + 10;

  // A tender title can be long: wrapped so it never runs off the page.
  const subject = doc.splitTextToSize(`Perihal: ${layout.title}`, W - M * 2) as string[];
  text(9, true);
  doc.text(subject, M, y);
  y += subject.length * 11 + 8;

  text(9);
  const opening = doc.splitTextToSize(layout.opening, W - M * 2) as string[];
  doc.text(opening, M, y);
  const tableY = y + (opening.length - 1) * 11 + 10;

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
    image: { cellWidth: 52, minCellHeight: 50 },
  };
  const cell = (key: DocColumnKey, r: ComputedRow): string => {
    if (key === "name" && layout.codeUnderName && shownCode(r.code)) return `${r.name}\n${shownCode(r.code)}`;
    const v = docCell(key, r, r.prices[scenario]);
    return typeof v === "number" && key !== "no" ? grp(v) : String(v);
  };
  const columns = layout.columns;
  const offered = offeredRows(engine.rows);
  const imageCol = columns.findIndex((c) => c.key === "image");
  autoTable(doc, {
    startY: tableY,
    head: [columns.map((c) => c.label)],
    body: offered.map((r) => columns.map((c) => cell(c.key, r))),
    styles: { fontSize: 8.5, cellPadding: 4, lineColor: [238, 241, 244], lineWidth: 0.5 },
    headStyles: { fillColor: [246, 248, 250], textColor: [27, 37, 48], fontStyle: "bold" },
    columnStyles: Object.fromEntries(columns.map((c, i) => [i, STYLE[c.key]])),
    margin: { left: M, right: M, bottom: FOOT + 16 },
    didDrawCell: (data) => {
      if (data.section !== "body" || data.column.index !== imageCol) return;
      const src = input.images?.[offered[data.row.index]?.code];
      if (!src) return;
      const { width, height } = doc.getImageProperties(src);
      const box = Math.min(data.cell.width, data.cell.height) - 6;
      const k = Math.min(box / width, box / height);
      const w = width * k, h = height * k;
      doc.addImage(src, imageFormat(src), data.cell.x + (data.cell.width - w) / 2, data.cell.y + (data.cell.height - h) / 2, w, h);
    },
  });

  const totals = docTotals(layout, s, assumptions);
  if (totals.length) autoTable(doc, {
    startY: (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 10,
    // Keep the totals together: a subtotal stranded alone at the foot of a
    // page reads as a mistake on a document going to a client.
    pageBreak: "avoid",
    theme: "plain",
    styles: { fontSize: 9.5, cellPadding: 3 },
    columnStyles: { 0: { halign: "right", cellWidth: 260 }, 1: { halign: "right", cellWidth: 112, fontStyle: "bold" } },
    margin: { left: W - M - 372, right: M },
    body: totals.map((row) => [row.label, "Rp " + grp(row.value)]),
    didParseCell: (data) => {
      if (totals[data.row.index]?.key === "monthly") data.cell.styles.fontStyle = "bold";
    },
  });

  y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 18;
  const notes = [
    ...docNotes(meta, company),
    ...(heldNote(engine.rows) ? [`Item menyusul: ${heldNote(engine.rows)}`] : []),
    ...(meta.notes ? [meta.notes] : []),
  ];
  const noteLines = notes.flatMap((n) => (doc.splitTextToSize(n, W - M * 2 - 12) as string[]).map((l, i) => (i ? `   ${l}` : `• ${l}`)));
  if (y + 12 + noteLines.length * 10 > pageH - FOOT - 16) {
    doc.addPage();
    y = 60;
  }
  text(8.5, true);
  doc.text("Note:", M, y);
  text(8.5);
  doc.text(noteLines, M + 4, y + 11);
  y += 11 + noteLines.length * 10;

  text(9);
  const closing = doc.splitTextToSize(layout.closing, W - M * 2) as string[];
  doc.text(closing, M, y + 12);
  y += closing.length * 11 + 12;

  // Signature block (meeting 2026-10-05): room for a wet or digital signature
  // on both sides. Kept whole: moved to a new page if it would be cut off.
  const SIGN_H = 120;
  y += 22;
  if (y + SIGN_H > pageH - FOOT - 16) {
    doc.addPage();
    y = 60;
  }
  const colW = (W - M * 2 - 40) / 2;
  const sign = (x: number, lead: string, party: string, lines: string[], image?: string) => {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8.5);
    doc.setTextColor(...MUTED);
    doc.text(lead, x, y);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(30, 37, 48);
    doc.text(doc.splitTextToSize(party, colW) as string[], x, y + 12);
    const lineY = y + 84;
    if (image) fit(image, x, y + 18, colW * 0.8, lineY - y - 22);
    doc.setDrawColor(30, 37, 48);
    doc.line(x, lineY, x + colW * 0.8, lineY);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8.5);
    lines.forEach((l, i) => {
      doc.setTextColor(...(i === 0 ? ([30, 37, 48] as [number, number, number]) : MUTED));
      doc.text(l, x, lineY + 12 + i * 11);
    });
  };
  const signature = input.signature?.image ? input.signature : null;
  sign(M, "Hormat kami,", company.name, [signature?.name || meta.preparedBy || "Nama"], signature?.image);
  if (!meta.hideClientSign) sign(M + colW + 40, "Disetujui oleh,", clientName, ["Nama & jabatan:", "Tanggal:"]);
  y += SIGN_H;

  // Letterhead at the foot of every page, as in the company template, with the page count.
  const pages = doc.getNumberOfPages();
  const contacts = [company.email, company.phone].filter(Boolean).join(" · ");
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    const top = pageH - FOOT;
    doc.setDrawColor(220, 226, 232);
    doc.line(M, top, W - M, top);
    text(9.5, true);
    doc.text(company.name, W / 2, top + 13, { align: "center" });
    text(7.5, false, MUTED);
    if (company.address) doc.text(doc.splitTextToSize(company.address, W - M * 2) as string[], W / 2, top + 25, { align: "center" });
    if (contacts) doc.text(contacts, W / 2, top + 36, { align: "center" });
    doc.text(`${number || meta.quoteNo} · ${SCENARIOS[scenario].key} · Halaman ${i} dari ${pages}`, W - M, pageH - 14, { align: "right" });
  }
  return doc;
}

export async function downloadQuotationPdf(input: Input): Promise<void> {
  const safe = (input.number || input.meta.quoteNo || "quotation").replace(/[^\w-]+/g, "-");
  const withImages = docLayout(input.meta, input.template, "print").columns.some((c) => c.key === "image");
  const images = withImages ? await loadDocImages(offeredRows(input.engine.rows).map((r) => r.code)) : undefined;
  quotationPdf({ ...input, images }).save(`${safe}.pdf`);
}
