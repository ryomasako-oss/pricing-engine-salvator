/* The signature block must never be split across pages: wherever the item
   table ends, "Hormat kami," and the last line ("Tanggal:") share a page. */

import { describe, expect, it } from "vitest";
import { DEFAULT_ASSUMPTIONS, DEFAULT_REGIONS, computeEngine } from "@shared/engine";
import type { DocTemplate, QuoteItem, QuoteMeta } from "@shared/types";
import { quotationPdf } from "./pdf";

const meta: QuoteMeta = {
  quoteNo: "Q-1", date: "2026-10-05", validity: 30, payment: "setelah invoice", delivery: "Franco Jakarta",
  notes: "", preparedBy: "Sales Satu", paymentDays: 30, warrantyYears: 1,
};
const company = { name: "PT Salvator Inti Pratama", brand: "", tagline: "", address: "Jakarta", phone: "", email: "", npwp: "", bank: "" };

const DOT = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function pdfFor(n: number, over: Partial<QuoteMeta> = {}, template?: DocTemplate | null, signature?: { name: string; image: string }, images?: Record<string, string>) {
  const items: QuoteItem[] = Array.from({ length: n }, (_, i) => ({
    id: `i${i}`, lineNo: i + 1, code: `C${i}`, name: `Item nomor ${i + 1}`, uom: "Pcs", qty: 1, cogs: 1000, rrp: 2000, role: "CORE",
    notes: `Catatan ${i + 1}`,
  }));
  return quotationPdf({
    engine: computeEngine(DEFAULT_ASSUMPTIONS, items, DEFAULT_REGIONS), meta: { ...meta, ...over }, assumptions: DEFAULT_ASSUMPTIONS,
    scenario: 0, company, clientName: "PT Klien", number: "Q-1", draft: false, template, signature, images,
  });
}

/** How many times an image is painted (`/I<n> Do`) across all pages. */
const imageDraws = (doc: ReturnType<typeof pdfFor>) =>
  (doc.internal as unknown as { pages: (string[] | undefined)[] }).pages.reduce(
    (n, ops) => n + (ops?.filter((op) => /\/I\d+ Do/.test(op)).length ?? 0),
    0,
  );

/** 1-based page numbers whose content stream draws this exact text. */
function pagesWith(doc: ReturnType<typeof pdfFor>, text: string): number[] {
  const pages = (doc.internal as unknown as { pages: (string[] | undefined)[] }).pages;
  const out: number[] = [];
  pages.forEach((ops, i) => {
    if (ops?.some((op) => op.includes(`(${text})`))) out.push(i);
  });
  return out;
}

/** 1-based page numbers whose content stream draws text containing this. */
function pagesContaining(doc: ReturnType<typeof pdfFor>, text: string): number[] {
  const pages = (doc.internal as unknown as { pages: (string[] | undefined)[] }).pages;
  return pages.flatMap((ops, i) => (ops?.some((op) => op.includes(text)) ? [i] : []));
}

/** Distance from the bottom edge (PDF coordinates) of the first draw of this text. */
function bottomOffset(doc: ReturnType<typeof pdfFor>, text: string): number {
  const pages = (doc.internal as unknown as { pages: (string[] | undefined)[] }).pages;
  for (const ops of pages) {
    const op = ops?.find((o) => o.includes(`(${text})`));
    const m = op && /([\d.]+) (-?[\d.]+) Td\n\(/.exec(op);
    if (m) return Number(m[2]);
    const partial = ops?.find((o) => o.includes(`(${text}`));
    const p = partial && /([\d.]+) (-?[\d.]+) Td\n\(/.exec(partial);
    if (p) return Number(p[2]);
  }
  throw new Error(`"${text}" not drawn`);
}

describe("quotation PDF item photos", () => {
  it("paints each line's photo in the Gambar column; a code without one stays blank", () => {
    const logoOnly = imageDraws(pdfFor(3, { showImages: true }));
    // C0 and C2 have a photo, C1 has none.
    const d = pdfFor(3, { showImages: true }, null, undefined, { C0: DOT, C2: DOT });
    expect(pagesWith(d, "Gambar")).toEqual([1]);
    expect(imageDraws(d) - logoOnly).toBe(2);
    // Photos given but the option off: no column, nothing painted.
    expect(imageDraws(pdfFor(3, {}, null, undefined, { C0: DOT, C2: DOT }))).toBe(logoOnly);
  });

  it("taller rows still keep the signature block on one page, 1 to 40 items", () => {
    for (let n = 1; n <= 40; n++) {
      const images = Object.fromEntries(Array.from({ length: n }, (_, i) => [`C${i}`, DOT]));
      const doc = pdfFor(n, { showImages: true }, null, undefined, images);
      const top = pagesWith(doc, "Hormat kami,");
      expect(top, `n=${n}`).toHaveLength(1);
      expect(pagesWith(doc, "Tanggal:"), `n=${n}`).toEqual(top);
      expect(bottomOffset(doc, "Tanggal:"), `n=${n}`).toBeGreaterThan(32);
    }
  });
});

describe("quotation PDF columns", () => {
  const has = (doc: ReturnType<typeof pdfFor>, t: string) => pagesWith(doc, t).length > 0;
  /** How many times this exact text is drawn on any page. */
  const draws = (doc: ReturnType<typeof pdfFor>, t: string) =>
    (doc.internal as unknown as { pages: (string[] | undefined)[] }).pages.reduce(
      (n, ops) => n + (ops?.filter((op) => op.includes(`(${t})`)).length ?? 0),
      0,
    );

  it("shows Qty, line totals and the totals block by default", () => {
    const d = pdfFor(2);
    expect(has(d, "Qty")).toBe(true);
    expect(has(d, "Total")).toBe(true);
    expect(has(d, "Subtotal")).toBe(true);
  });

  it("drops only the line total when hideLineTotal is set", () => {
    const d = pdfFor(2, { hideLineTotal: true });
    expect(has(d, "Qty")).toBe(true);
    expect(has(d, "Harga satuan")).toBe(true);
    // "Total" is the column head and also a row of the totals block.
    expect(draws(pdfFor(2), "Total")).toBe(2);
    expect(draws(d, "Total")).toBe(1);
    expect(has(d, "Subtotal")).toBe(true);
  });

  it("is a plain price list when hideQty is set: no Qty, no totals, price still right-aligned", () => {
    const d = pdfFor(2, { hideQty: true });
    expect(has(d, "Qty")).toBe(false);
    expect(has(d, "Total")).toBe(false);
    expect(has(d, "Subtotal")).toBe(false);
    expect(has(d, "Harga satuan")).toBe(true);
    expect(has(d, "Hormat kami,")).toBe(true);
  });
});

// Builds real workbooks/PDFs: ~2.5 s alone, past vitest's 5 s default when the whole
// suite runs in parallel on a busy machine.
describe("quotation PDF", { timeout: 20_000 }, () => {
  it("shows term of payment and warranty", () => {
    const doc = pdfFor(3);
    expect(pagesContaining(doc, "Term of payment: 30 hari setelah invoice")).toEqual([1]);
    expect(pagesContaining(doc, "Garansi: 1 tahun")).toEqual([1]);
  });

  it("keeps the signature block on one page for every table length from 1 to 60 items", () => {
    const moved: number[] = [];
    for (let n = 1; n <= 60; n++) {
      const doc = pdfFor(n);
      const top = pagesWith(doc, "Hormat kami,");
      const bottom = pagesWith(doc, "Tanggal:");
      expect(top, `n=${n}`).toHaveLength(1);
      expect(bottom, `n=${n}`).toEqual(top);
      // Inside the page and clear of the footer line drawn 22pt from the bottom.
      expect(bottomOffset(doc, "Tanggal:"), `n=${n}`).toBeGreaterThan(32);
      // The block may start a page of its own: then it is the last page.
      expect(top[0], `n=${n}`).toBe(doc.getNumberOfPages());
      if (top[0] > 1 && pagesWith(doc, `Item nomor ${n}`)[0] < top[0]) moved.push(n);
    }
    // Some lengths must actually exercise the "move to next page" branch.
    expect(moved.length).toBeGreaterThan(0);
  });
});

describe("quotation PDF after a partial sales Tolak", () => {
  it("leaves the rejected line out of the table and totals and names it as item menyusul", () => {
    const items: QuoteItem[] = [
      { id: "a", lineNo: 1, code: "A", name: "Pulpen diterima", uom: "Pcs", qty: 10, cogs: 1000, rrp: 2000, role: "CORE" },
      { id: "b", lineNo: 2, code: "B", name: "Kertas ditolak", uom: "Rim", qty: 5, cogs: 40000, rrp: 60000, role: "CORE", held: true, holdReason: "sales" },
    ];
    const engine = computeEngine(DEFAULT_ASSUMPTIONS, items, DEFAULT_REGIONS);
    const doc = quotationPdf({
      engine, meta, assumptions: DEFAULT_ASSUMPTIONS, scenario: 0, company, clientName: "PT Klien", number: "Q-1", draft: false,
    });
    const ops = (doc.internal as unknown as { pages: (string[] | undefined)[] }).pages.flatMap((p) => p ?? []).join("\n");
    expect(pagesWith(doc, "Pulpen diterima")).toEqual([1]);
    expect(pagesWith(doc, "Kertas ditolak")).toEqual([]);
    expect(ops).toMatch(/item menyusul[^)]*Kertas ditolak/i);
    expect(engine.scen[0].revenue).toBe(engine.rows[0].prices[0] * 10);
  });
});

describe("quotation PDF with a client document template", () => {
  /** Left edge (x) of the first draw of this exact text, to read the column order. */
  const xOf = (doc: ReturnType<typeof pdfFor>, text: string): number => {
    const pages = (doc.internal as unknown as { pages: (string[] | undefined)[] }).pages;
    for (const ops of pages) {
      const op = ops?.find((o) => o.includes(`(${text})`));
      const m = op && /([\d.]+) (-?[\d.]+) Td\n\(/.exec(op);
      if (m) return Number(m[1]);
    }
    return NaN;
  };
  const order = (doc: ReturnType<typeof pdfFor>, heads: string[]) => [...heads].sort((a, b) => xOf(doc, a) - xOf(doc, b));
  const STANDARD = ["No", "Item", "Satuan", "Qty", "Harga satuan", "Total"];

  it("a quote whose client has no template prints the same columns, title and code line as before", () => {
    for (const t of [undefined, null]) {
      const d = pdfFor(2, {}, t);
      expect(order(d, STANDARD)).toEqual(STANDARD);
      expect(pagesWith(d, "Perihal: Penawaran Harga")).toEqual([1]);
      expect(pagesWith(d, "Kode")).toEqual([]);
      expect(pagesWith(d, "Catatan 1")).toEqual([]);
      // The code still sits under the item name.
      expect(xOf(d, "C0")).toBe(xOf(d, "Item nomor 1"));
    }
  });

  it("prints the template's columns in its order and headings, its title and its text", () => {
    const d = pdfFor(2, {}, {
      columns: [
        { key: "no", label: "No." }, { key: "name", label: "Uraian" }, { key: "qty", label: "Volume" },
        { key: "price", label: "Harga Rp" }, { key: "code", label: "Kd" }, { key: "notes", label: "Spesifikasi" },
      ],
      title: "Surat Penawaran Tender",
      opening: "Dengan hormat, bersama ini kami sampaikan penawaran.",
      closing: "Demikian penawaran ini kami sampaikan.",
    });
    expect(order(d, ["Kd", "Spesifikasi", "Harga Rp", "Volume", "No.", "Uraian"])).toEqual(
      ["No.", "Uraian", "Volume", "Harga Rp", "Kd", "Spesifikasi"],
    );
    expect(pagesWith(d, "Perihal: Surat Penawaran Tender")).toEqual([1]);
    expect(pagesWith(d, "Perihal: Penawaran Harga")).toEqual([]);
    expect(pagesWith(d, "Dengan hormat, bersama ini kami sampaikan penawaran.")).toEqual([1]);
    expect(pagesWith(d, "Demikian penawaran ini kami sampaikan.")).toEqual([1]);
    expect(pagesWith(d, "Catatan 1")).toEqual([1]);
    for (const gone of ["Qty", "Item", "Satuan"]) expect(pagesWith(d, gone), gone).toEqual([]);
    // Totals block stays (showTotals absent); hideQty still wins over the template.
    expect(pagesWith(d, "Subtotal")).toEqual([1]);
    const plain = pdfFor(2, { hideQty: true }, { columns: [{ key: "name", label: "Uraian" }, { key: "qty", label: "Volume" }, { key: "price", label: "Harga" }] });
    expect(pagesWith(plain, "Volume")).toEqual([]);
    expect(pagesWith(plain, "Subtotal")).toEqual([]);
  });

  it("wraps a long tender title inside the page, below the client block", () => {
    const title = "Surat Penawaran Harga Pengadaan Alat Tulis Kantor Tahun Anggaran 2027 Kantor Pusat Dan Seluruh Kantor Cabang Di Wilayah Jawa Bali Sumatra Kalimantan Dan Sulawesi Cabang";
    const d = pdfFor(1, {}, { title });
    expect(pagesWith(d, `Perihal: ${title}`)).toEqual([]);
    // Wrapped, not cut: the last words are still drawn, and the first line sits below "Kepada Yth." (PDF y grows upwards).
    expect(pagesContaining(d, "Sulawesi Cabang")).toEqual([1]);
    expect(bottomOffset(d, "Perihal: Surat")).toBeLessThan(bottomOffset(d, "Kepada Yth."));
  });
});

describe("quotation PDF letter", () => {
  const images = (d: ReturnType<typeof pdfFor>) =>
    (d.internal as unknown as { pages: (string[] | undefined)[] }).pages.reduce((n, ops) => n + (ops?.filter((o) => / Do$/m.test(o)).length ?? 0), 0);

  it("draws the logo, and the signature with the signer's name only when one is given", () => {
    const plain = pdfFor(2);
    expect(images(plain)).toBe(1);
    expect(pagesWith(plain, "Sales Satu")).toEqual([1]);
    const signed = pdfFor(2, {}, undefined, { name: "Ernita", image: DOT });
    expect(images(signed)).toBe(2);
    expect(pagesWith(signed, "Ernita")).toEqual([1]);
  });

  it("puts the letterhead on every page", () => {
    const d = pdfFor(60);
    expect(d.getNumberOfPages()).toBeGreaterThan(1);
    expect(pagesWith(d, "PT Salvator Inti Pratama").length).toBeGreaterThanOrEqual(d.getNumberOfPages());
  });
});
