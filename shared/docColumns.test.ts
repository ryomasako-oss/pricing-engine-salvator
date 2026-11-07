import { describe, expect, it } from "vitest";
import { DOC_COLUMN_KEYS, docCell, docColumns, docLayout, docTotals } from "./docColumns";
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
      { key: "subtotal", label: "Subtotal per bulan", value: 1000 },
      { key: "ppn", label: "PPN 11%", value: 110 },
      { key: "monthly", label: "Total per bulan", value: 1110 },
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
      expect(keys(print)).toEqual(["no:No", "name:Item", "uom:Satuan", "qty:Qty", "price:Harga satuan", "total:Total per bulan"]);
      expect(print).toMatchObject({ totals: true, title: "Penawaran Harga", opening: "", closing: "", codeUnderName: true });
      const sheet = docLayout({}, t, "sheet");
      expect(keys(sheet)).toEqual(["no:No", "code:Kode", "name:Item", "uom:Satuan", "qty:Qty", "price:Harga satuan", "total:Total per bulan"]);
      expect(sheet.codeUnderName).toBe(false);
    }
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
    expect(DOC_COLUMN_KEYS.map((k) => docCell(k, r, 2500))).toEqual([3, "ATK-1", "Pulpen", "Pcs", 4, 2500, 10000, "Merk Standard"]);
  });
});
