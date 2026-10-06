import { describe, expect, it } from "vitest";
import { checkSalesReview, rejectionNote } from "./salesReview";

const quote = {
  status: "approved",
  rev_no: 2,
  version: 5,
  items: [
    { id: "a", lineNo: 1, name: "Pulpen" },
    { id: "b", lineNo: 2, name: "Kertas" },
    { id: "h", lineNo: 3, name: "Tinta", held: true },
  ],
};
const acc = (id: string) => ({ id, decision: "acc" as const, reason: "" });

describe("checkSalesReview", () => {
  it("accepts all ACC and reports no rejected line", () => {
    const r = checkSalesReview(quote, { rev_no: 2, version: 5, lines: [acc("a"), acc("b")] });
    expect(r).toMatchObject({ ok: true, rejected: [] });
  });

  it("returns the rejected lines with their number, name and trimmed reason", () => {
    const r = checkSalesReview(quote, {
      rev_no: 2, version: 5, lines: [acc("a"), { id: "b", decision: "tolak", reason: " klien minta 48rb " }],
    });
    expect(r.ok && r.rejected).toEqual([{ id: "b", lineNo: 2, name: "Kertas", decision: "tolak", reason: "klien minta 48rb" }]);
  });

  it("refuses a quote that is not approved", () => {
    expect(checkSalesReview({ ...quote, status: "draft" }, { rev_no: 2, version: 5, lines: [acc("a"), acc("b")] }))
      .toMatchObject({ ok: false, status: 409 });
  });

  it("refuses a file from an older revision or version", () => {
    for (const [rev_no, version] of [[1, 5], [2, 4]]) {
      const r = checkSalesReview(quote, { rev_no, version, lines: [acc("a"), acc("b")] });
      expect(r).toMatchObject({ ok: false, status: 409 });
      expect(!r.ok && r.error).toMatch(/versi lama/);
    }
  });

  it("refuses unknown, duplicated or held lines, and missing lines", () => {
    const bad = [[acc("a"), acc("b"), acc("x")], [acc("a"), acc("a"), acc("b")], [acc("a"), acc("b"), acc("h")]];
    for (const lines of bad) expect(checkSalesReview(quote, { rev_no: 2, version: 5, lines })).toMatchObject({ ok: false, status: 400 });
    const r = checkSalesReview(quote, { rev_no: 2, version: 5, lines: [acc("a")] });
    expect(!r.ok && r.error).toBe("Baris 2 belum diisi ACC atau Tolak.");
  });

  it("refuses Tolak without a reason", () => {
    const r = checkSalesReview(quote, { rev_no: 2, version: 5, lines: [acc("a"), { id: "b", decision: "tolak", reason: "  " }] });
    expect(!r.ok && r.error).toBe("Baris 2 ditolak tanpa alasan. Isi kolom Alasan.");
  });
});

describe("rejectionNote", () => {
  it("names the reviewer and every rejected line with its reason", () => {
    expect(rejectionNote("Sales Satu", [{ id: "b", lineNo: 2, name: "Kertas", decision: "tolak", reason: "mahal" }]))
      .toBe("Ditolak sales (Sales Satu): baris 2 Kertas — mahal. Perbaiki harga baris itu lalu ajukan lagi.");
  });
});
