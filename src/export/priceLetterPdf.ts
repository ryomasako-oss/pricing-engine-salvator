/* Surat perubahan harga ke klien (Ryoma, 2026-11-26): same letter frame as the quotation (logo, place and
   date, Kepada Yth., the letterhead at the foot, signature), for the items of one SI that sold at a loss.
   The signature prints only once the letter is ACC'd (GET /api/price-letters/:id/signature). */

import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { fmtDate, grp } from "@shared/format";
import type { CompanyInfo, DocSignature } from "../components/QuotationDoc";
import { DEFAULT_LOGO } from "../assets/defaultLogo";

export interface PriceLetter {
  number: string;
  invoice_no: string;
  invoice_date: string;
  customer_name: string;
  client_name?: string | null;
  client_address?: string | null;
  client_contact?: string | null;
  effective_date: string;
  note: string;
  status: "draft" | "approved" | "rejected";
  created_at: string;
  created_by_name: string;
}
export interface PriceLetterLine {
  line_no: number;
  code: string;
  name: string;
  unit: string;
  old_price: number;
  new_price: number;
}

const MUTED: [number, number, number] = [102, 115, 132];
const INK: [number, number, number] = [30, 37, 48];

/** The letter's wording, shared by the PDF and the on-screen preview. */
export function letterText(l: PriceLetter, company: CompanyInfo) {
  return {
    subject: "Pemberitahuan Penyesuaian Harga",
    opening:
      `Dengan hormat,\n\nTerima kasih atas kepercayaan yang diberikan kepada ${company.name}. ` +
      `Sehubungan dengan kenaikan harga beli dari pemasok, dengan ini kami memberitahukan penyesuaian harga untuk barang ` +
      `berikut (berdasarkan faktur ${l.invoice_no} tanggal ${fmtDate(l.invoice_date)}), berlaku mulai ${fmtDate(l.effective_date)}:`,
    closing:
      "Harga di atas belum termasuk PPN. Pesanan yang sudah kami terima sebelum tanggal berlaku tetap memakai harga lama. " +
      "Demikian pemberitahuan ini kami sampaikan. Atas perhatian dan kerja samanya kami ucapkan terima kasih.",
  };
}

export function priceLetterPdf(l: PriceLetter, lines: PriceLetterLine[], company: CompanyInfo, signature: DocSignature | null): jsPDF {
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const W = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const M = 40;
  const FOOT = 64;
  const words = letterText(l, company);
  const text = (size: number, bold = false, color = INK) => {
    doc.setFont("helvetica", bold ? "bold" : "normal");
    doc.setFontSize(size);
    doc.setTextColor(...color);
  };
  const fit = (src: string, x: number, y: number, maxW: number, maxH: number) => {
    const { width, height } = doc.getImageProperties(src);
    const k = Math.min(maxW / width, maxH / height, 1);
    doc.addImage(src, src.startsWith("data:image/png") ? "PNG" : "JPEG", x, y, width * k, height * k);
    return height * k;
  };

  const logoBottom = 24 + fit(company.logo || DEFAULT_LOGO, M, 24, 120, 70);
  text(9);
  doc.text(`${company.city || "Jakarta"}, ${fmtDate(l.created_at.slice(0, 10))}`, W - M, 40, { align: "right" });
  doc.text(`No. ${l.number}`, W - M, 52, { align: "right" });
  if (l.status !== "approved") {
    text(9, true, [180, 35, 24]);
    doc.text(l.status === "rejected" ? "DITOLAK — tidak berlaku" : "DRAFT — belum di-ACC", W - M, 66, { align: "right" });
  }

  let y = logoBottom + 20;
  text(9, true);
  doc.text("Kepada Yth.", M, y);
  text(9);
  const to = [
    ...(doc.splitTextToSize(l.client_name || l.customer_name, W / 2) as string[]),
    ...(l.client_contact ? [`Up: ${l.client_contact}`] : []),
    ...(l.client_address ? (doc.splitTextToSize(l.client_address, W / 2) as string[]) : []),
  ];
  doc.text(to, M, y + 12);
  y += 12 + to.length * 11 + 10;
  text(9, true);
  doc.text(`Perihal: ${words.subject}`, M, y);
  y += 19;
  text(9);
  const opening = doc.splitTextToSize(words.opening, W - M * 2) as string[];
  doc.text(opening, M, y);

  autoTable(doc, {
    startY: y + opening.length * 11,
    head: [["No", "Kode", "Nama barang", "Satuan", "Harga lama", "Harga baru"]],
    body: lines.map((x) => [x.line_no, x.code, x.name, x.unit, grp(x.old_price), grp(x.new_price)]),
    styles: { fontSize: 8.5, cellPadding: 4, lineColor: [238, 241, 244], lineWidth: 0.5 },
    headStyles: { fillColor: [246, 248, 250], textColor: [27, 37, 48], fontStyle: "bold" },
    columnStyles: {
      0: { halign: "center", cellWidth: 26 }, 1: { cellWidth: 58 }, 3: { halign: "center", cellWidth: 50 },
      4: { halign: "right", cellWidth: 76 }, 5: { halign: "right", cellWidth: 76, fontStyle: "bold" },
    },
    margin: { left: M, right: M, bottom: FOOT + 16 },
  });
  y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 18;

  const closing = doc.splitTextToSize([words.closing, l.note].filter(Boolean).join("\n\n"), W - M * 2) as string[];
  const SIGN_H = 120;
  if (y + closing.length * 11 + 22 + SIGN_H > pageH - FOOT - 16) {
    doc.addPage();
    y = 60;
  }
  text(9);
  doc.text(closing, M, y);
  y += closing.length * 11 + 22;

  text(8.5, false, MUTED);
  doc.text("Hormat kami,", M, y);
  text(8.5, true);
  doc.text(company.name, M, y + 12);
  const lineY = y + 84;
  if (signature?.image && l.status === "approved") fit(signature.image, M, y + 18, 180, lineY - y - 22);
  doc.setDrawColor(...INK);
  doc.line(M, lineY, M + 180, lineY);
  text(8.5);
  doc.text(signature?.name || l.created_by_name, M, lineY + 12);

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
    doc.text(`${l.number} · Halaman ${i} dari ${pages}`, W - M, pageH - 14, { align: "right" });
  }
  return doc;
}

export const downloadPriceLetterPdf = (...a: Parameters<typeof priceLetterPdf>) =>
  priceLetterPdf(...a).save(`${a[0].number.replace(/[^\w-]+/g, "-")}.pdf`);
