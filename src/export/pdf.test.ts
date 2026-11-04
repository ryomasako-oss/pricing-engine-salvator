/* The signature block must never be split across pages: wherever the item
   table ends, "Hormat kami," and the last line ("Tanggal:") share a page. */

import { describe, expect, it } from "vitest";
import { DEFAULT_ASSUMPTIONS, DEFAULT_REGIONS, computeEngine } from "@shared/engine";
import type { QuoteItem, QuoteMeta } from "@shared/types";
import { quotationPdf } from "./pdf";

const meta: QuoteMeta = {
  quoteNo: "Q-1", date: "2026-10-05", validity: 30, payment: "setelah invoice", delivery: "Franco Jakarta",
  notes: "", preparedBy: "Sales Satu", paymentDays: 30, warrantyYears: 1,
};
const company = { name: "PT Salvator Inti Pratama", brand: "", tagline: "", address: "Jakarta", phone: "", email: "", npwp: "", bank: "" };

function pdfFor(n: number, over: Partial<QuoteMeta> = {}) {
  const items: QuoteItem[] = Array.from({ length: n }, (_, i) => ({
    id: `i${i}`, lineNo: i + 1, code: `C${i}`, name: `Item nomor ${i + 1}`, uom: "Pcs", qty: 1, cogs: 1000, rrp: 2000, role: "CORE",
  }));
  return quotationPdf({
    engine: computeEngine(DEFAULT_ASSUMPTIONS, items, DEFAULT_REGIONS), meta: { ...meta, ...over }, assumptions: DEFAULT_ASSUMPTIONS,
    scenario: 0, company, clientName: "PT Klien", number: "Q-1", draft: false,
  });
}

/** 1-based page numbers whose content stream draws this exact text. */
function pagesWith(doc: ReturnType<typeof pdfFor>, text: string): number[] {
  const pages = (doc.internal as unknown as { pages: (string[] | undefined)[] }).pages;
  const out: number[] = [];
  pages.forEach((ops, i) => {
    if (ops?.some((op) => op.includes(`(${text})`))) out.push(i);
  });
  return out;
}

/** Distance from the bottom edge (PDF coordinates) of the first draw of this text. */
function bottomOffset(doc: ReturnType<typeof pdfFor>, text: string): number {
  const pages = (doc.internal as unknown as { pages: (string[] | undefined)[] }).pages;
  for (const ops of pages) {
    const op = ops?.find((o) => o.includes(`(${text})`));
    const m = op && /([\d.]+) (-?[\d.]+) Td\n\(/.exec(op);
    if (m) return Number(m[2]);
  }
  throw new Error(`"${text}" not drawn`);
}

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
    expect(has(d, "Total per bulan")).toBe(true);
    expect(has(d, "Subtotal per bulan")).toBe(true);
  });

  it("drops only the line total when hideLineTotal is set", () => {
    const d = pdfFor(2, { hideLineTotal: true });
    expect(has(d, "Qty")).toBe(true);
    expect(has(d, "Harga satuan")).toBe(true);
    // "Total per bulan" is the column head and also a row of the totals block.
    expect(draws(pdfFor(2), "Total per bulan")).toBe(2);
    expect(draws(d, "Total per bulan")).toBe(1);
    expect(has(d, "Subtotal per bulan")).toBe(true);
  });

  it("is a plain price list when hideQty is set: no Qty, no totals, price still right-aligned", () => {
    const d = pdfFor(2, { hideQty: true });
    expect(has(d, "Qty")).toBe(false);
    expect(has(d, "Total per bulan")).toBe(false);
    expect(has(d, "Subtotal per bulan")).toBe(false);
    expect(has(d, "Harga satuan")).toBe(true);
    expect(has(d, "Hormat kami,")).toBe(true);
  });
});

describe("quotation PDF", () => {
  it("shows term of payment and warranty", () => {
    const doc = pdfFor(3);
    expect(pagesWith(doc, "Term of payment")).toEqual([1]);
    expect(pagesWith(doc, "30 hari setelah invoice")).toEqual([1]);
    expect(pagesWith(doc, "1 tahun")).toEqual([1]);
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
