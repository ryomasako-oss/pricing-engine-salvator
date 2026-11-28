import { describe, expect, it } from "vitest";
import { DEFAULT_DOC_CLOSING, DEFAULT_DOC_OPENING, DOC_COLUMN_KEYS, autoNotes, companyNotes, docCell, staleNote, docColumns, docLayout, docNotes, docTotals } from "./docColumns";
import type { ComputedRow, DocTemplate } from "./types";

describe("docColumns", () => {
  it("shows everything by default", () => {
    expect(docColumns({})).toEqual({ qty: true, lineTotal: true, totals: true });
  });
  it("can drop the line total alone and keep the quote totals", () => {
    expect(docColumns({ hideLineTotal: true })).toEqual({ qty: true, lineTotal: false, totals: true });
  });
  it("hiding qty also hides line totals and the totals block, which depend on it", () => {
    expect(docColumns({ hideQty: true })).toEqual({ qty: false, lineTotal: false, totals: false });
    expect(docColumns({ hideQty: true, hideLineTotal: false })).toEqual({ qty: false, lineTotal: false, totals: false });
  });
});

describe("docLayout: total rows one by one", () => {
  const s = { revenue: 1000, annual: 12000 };
  const a = { ppn: 0.11, months: 12 };
  it("prints all four rows by default, in order", () => {
    const l = docLayout({}, null, "print");
    expect(l.totalRows).toEqual(["subtotal", "ppn", "monthly", "contract"]);
    expect(docTotals(l, s, a)).toEqual([
      { key: "subtotal", label: "Subtotal", value: 1000 },
      { key: "ppn", label: "PPN 11%", value: 110 },
      { key: "monthly", label: "Total", value: 1110 },
      { key: "contract", label: "Nilai kontrak 12 bulan (belum PPN)", value: 12000 },
    ]);
  });
  it("drops only the rows the quote hides", () => {
    const l = docLayout({ hideTotalRows: ["contract"] }, null, "print");
    expect(l.totalRows).toEqual(["subtotal", "ppn", "monthly"]);
    expect(l.totals).toBe(true);
    expect(docLayout({ hideTotalRows: ["monthly", "contract"] }, null, "sheet").totalRows).toEqual(["subtotal", "ppn"]);
  });
  it("hiding every row hides the block; hiding qty or a template without totals still wins", () => {
    expect(docLayout({ hideTotalRows: ["subtotal", "ppn", "monthly", "contract"] }, null, "print").totals).toBe(false);
    expect(docLayout({ hideQty: true }, null, "print").totalRows).toEqual([]);
    expect(docLayout({}, { showTotals: false }, "print").totalRows).toEqual([]);
  });
});

describe("docLayout: client document template", () => {
  const keys = (l: ReturnType<typeof docLayout>) => l.columns.map((c) => `${c.key}:${c.label}`);
  const tender: DocTemplate = {
    columns: [
      { key: "no", label: "No." },
      { key: "name", label: "Uraian" },
      { key: "qty", label: "Volume" },
      { key: "uom", label: "Satuan" },
      { key: "price", label: "Harga Satuan (Rp)" },
      { key: "total", label: "Jumlah (Rp)" },
      { key: "notes", label: "Merk / Spesifikasi" },
    ],
    title: "  Surat Penawaran  ",
    opening: "Dengan hormat,",
  };

  it("without a template prints the standard columns, as before templates", () => {
    for (const t of [undefined, null, {}]) {
      const print = docLayout({}, t, "print");
      expect(keys(print)).toEqual(["no:No", "name:Item", "uom:Satuan", "qty:Qty", "price:Harga satuan", "total:Total"]);
      expect(print).toMatchObject({ totals: true, title: "Penawaran Harga", opening: DEFAULT_DOC_OPENING, closing: DEFAULT_DOC_CLOSING, codeUnderName: true });
      const sheet = docLayout({}, t, "sheet");
      expect(keys(sheet)).toEqual(["no:No", "code:Kode", "name:Item", "uom:Satuan", "qty:Qty", "price:Harga satuan", "total:Total"]);
      expect(sheet.codeUnderName).toBe(false);
    }
  });

  it("foto barang: a Gambar column after No on the printed document, never in the Excel sheet", () => {
    expect(keys(docLayout({ showImages: true }, null, "print")).slice(0, 3)).toEqual(["no:No", "image:Gambar", "name:Item"]);
    expect(keys(docLayout({ showImages: true }, null, "sheet")).some((k) => k.startsWith("image"))).toBe(false);
    expect(keys(docLayout({}, null, "print")).some((k) => k.startsWith("image"))).toBe(false); // off by default: old quotes print as before
    // A client template places the column itself, with its own heading.
    const withImage: DocTemplate = { columns: [{ key: "no", label: "No" }, { key: "name", label: "Uraian" }, { key: "image", label: "Foto" }] };
    expect(keys(docLayout({}, withImage, "print"))).toEqual(["no:No", "name:Uraian", "image:Foto"]);
    expect(keys(docLayout({}, withImage, "sheet"))).toEqual(["no:No", "name:Uraian"]);
  });

  it("keeps the template's order and headings, the same for print and sheet", () => {
    const print = docLayout({}, tender, "print");
    expect(keys(print)).toEqual([
      "no:No.", "name:Uraian", "qty:Volume", "uom:Satuan", "price:Harga Satuan (Rp)", "total:Jumlah (Rp)", "notes:Merk / Spesifikasi",
    ]);
    expect(keys(docLayout({}, tender, "sheet"))).toEqual(keys(print));
    expect(print).toMatchObject({ title: "Surat Penawaran", opening: "Dengan hormat,", codeUnderName: false, totals: true });
  });

  it("the quote's own options can only hide more", () => {
    expect(keys(docLayout({ hideLineTotal: true }, tender, "print"))).not.toContain("total:Jumlah (Rp)");
    const plain = docLayout({ hideQty: true }, tender, "print");
    expect(plain.columns.map((c) => c.key)).toEqual(["no", "name", "uom", "price", "notes"]);
    expect(plain.totals).toBe(false);
    expect(docLayout({}, { ...tender, showTotals: false }, "print").totals).toBe(false);
  });

  it("drops keys that are not line data, and a repeated key, even if the stored JSON has them", () => {
    const bad = {
      columns: [{ key: "cogs", label: "Modal" }, { key: "name", label: "A" }, { key: "name", label: "B" }, { key: "price", label: "Harga" }],
    } as unknown as DocTemplate;
    expect(keys(docLayout({}, bad, "print"))).toEqual(["name:A", "price:Harga"]);
  });

  it("falls back to the standard heading for a blank label", () => {
    const t: DocTemplate = { columns: [{ key: "name", label: " " }, { key: "price", label: "Harga" }] };
    expect(keys(docLayout({}, t, "print"))[0]).toBe("name:Item");
  });

  it("reads each cell from the line, Keterangan from the line notes", () => {
    const r = { lineNo: 3, code: "ATK-1", name: "Pulpen", uom: "Pcs", qty: 4, notes: "Merk Standard" } as ComputedRow;
    expect(DOC_COLUMN_KEYS.map((k) => docCell(k, r, 2500))).toEqual([3, "ATK-1", "Pulpen", "Pcs", 4, 2500, 10000, "Merk Standard", ""]); // Gambar is drawn, not text
  });
});

describe("docNotes: Note editable per quote, bank and NPWP locked (2026-11-28)", () => {
  const meta = { date: "2026-11-28", validity: 30, delivery: "Franco Jakarta", payment: "", paymentDays: 30, warrantyYears: 1 } as const;
  const company = { bank: "BCA 123 a.n. PT Salvator", npwp: "01.234.567.8-901.000" };
  const locked = ["Pembayaran ke BCA 123 a.n. PT Salvator.", "NPWP 01.234.567.8-901.000."];

  it("a quote without its own lines prints the automatic ones, as before", () => {
    const lines = docNotes(meta, company);
    expect(lines.slice(0, 2)).toEqual(["Harga dalam Rupiah per satuan, belum termasuk PPN.", "Term of payment: 30 hari."]);
    expect(lines.slice(-2)).toEqual(locked);
    expect(lines).toEqual([...autoNotes(meta), ...companyNotes(company)]);
  });

  it("the rep's lines replace the automatic ones; blank lines are dropped", () => {
    expect(docNotes({ ...meta, docNotes: ["Harga franco gudang klien.", "  ", "DP 30%."] }, company)).toEqual(["Harga franco gudang klien.", "DP 30%.", ...locked]);
  });

  it("bank and NPWP always print from the company, even when every line is removed", () => {
    expect(docNotes({ ...meta, docNotes: [] }, company)).toEqual(locked);
    expect(autoNotes(meta).some((l) => l.includes("NPWP") || l.includes("Pembayaran ke"))).toBe(false);
  });
});

describe("staleNote: an edited line that no longer matches the terms (Review #200)", () => {
  const meta = { date: "2026-11-28", validity: 30, delivery: "Franco Jakarta", payment: "", paymentDays: 30, warrantyYears: 1 } as const;
  const edited = autoNotes(meta);

  it("the date moved: the validity line written before is stale, and the current one is offered", () => {
    const now = autoNotes({ ...meta, date: "2026-12-05" });
    expect(staleNote(edited[4], now)).toBe("Penawaran berlaku 30 hari, sampai 4 Januari 2027.");
    expect(staleNote(edited[1], autoNotes({ ...meta, paymentDays: 14 }))).toBe("Term of payment: 14 hari.");
  });

  it("matching lines, lines of the rep's own, and terms no longer set are not flagged", () => {
    for (const l of edited) expect(staleNote(l, edited)).toBeNull();
    expect(staleNote("Harga sudah termasuk ongkos pasang.", edited)).toBeNull();
    expect(staleNote("Pengiriman: Franco Jakarta.", autoNotes({ ...meta, delivery: "" }))).toBeNull();
  });
});
