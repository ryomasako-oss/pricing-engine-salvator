/* The on-screen document reads the client template through the same
   docLayout as the PDF and Excel (shared/docColumns.ts). */

import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DEFAULT_ASSUMPTIONS, DEFAULT_REGIONS, computeEngine } from "@shared/engine";
import type { DocTemplate, QuoteItem, QuoteMeta } from "@shared/types";
import { QuotationDoc } from "./QuotationDoc";

const meta: QuoteMeta = { quoteNo: "Q-1", date: "2026-10-05", validity: 30, payment: "", delivery: "Franco", notes: "" };
const company = { name: "PT Salvator Inti Pratama", brand: "Salvator", tagline: "", address: "", phone: "", email: "", npwp: "", bank: "" };
const items: QuoteItem[] = [
  { id: "a", lineNo: 1, code: "ATK-1", name: "Pulpen", uom: "Pcs", qty: 10, cogs: 1000, rrp: 2000, role: "CORE", notes: "Merk Standard" },
];

const html = (template?: DocTemplate | null) =>
  renderToStaticMarkup(createElement(QuotationDoc, {
    engine: computeEngine(DEFAULT_ASSUMPTIONS, items, DEFAULT_REGIONS), meta, assumptions: DEFAULT_ASSUMPTIONS,
    scenario: 0, company, clientName: "PT Klien", number: "Q-1", showInternal: false, template,
  }));
const heads = (h: string) => [...h.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((m) => m[1]);

describe("QuotationDoc with a client template", () => {
  it("without one shows the standard columns and the code under the item, as before", () => {
    for (const t of [undefined, null]) {
      const h = html(t);
      expect(heads(h)).toEqual(["No", "Item", "Satuan", "Qty", "Harga satuan", "Total per bulan"]);
      expect(h).toContain('<td class="l">Pulpen<div class="muted small">ATK-1</div></td>');
      expect(h).toContain('<div class="quote-title">Penawaran Harga</div>');
      expect(h).not.toContain("Merk Standard");
    }
  });

  it("shows the template's columns, title and text, never as HTML", () => {
    const h = html({
      columns: [{ key: "name", label: "Uraian" }, { key: "notes", label: "Spesifikasi" }, { key: "price", label: "Harga" }],
      title: "Surat Penawaran",
      opening: "<b>Dengan hormat</b>",
    });
    expect(heads(h)).toEqual(["Uraian", "Spesifikasi", "Harga"]);
    expect(h).toContain("Surat Penawaran");
    expect(h).toContain("&lt;b&gt;Dengan hormat&lt;/b&gt;");
    expect(h).not.toContain("<b>Dengan");
    expect(h).toContain("Merk Standard");
    expect(h).not.toContain("ATK-1");
  });
});
