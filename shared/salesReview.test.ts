import { describe, expect, it } from "vitest";
import { checkSalesReview, followsSalesRejection, rejectionNote, salesOutcome } from "./salesReview";
import type { QuoteItem } from "./types";

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

describe("salesOutcome", () => {
  const it3 = (id: string, held = false): QuoteItem => ({ id, lineNo: 1, code: id, name: id, uom: "Pcs", qty: 1, cogs: 1, rrp: 2, role: "CORE", ...(held ? { held: true } : {}) });
  const items = [it3("a"), it3("b"), it3("h", true)];
  it("holds only the rejected lines as sales and keeps the rest", () => {
    const o = salesOutcome(items, [{ id: "b" }]);
    expect(o.mode).toBe("partial");
    expect(o.items.map((x) => [x.id, !!x.held, x.holdReason ?? null])).toEqual([["a", false, null], ["b", true, "sales"], ["h", true, null]]);
  });
  it("is 'all' when every offered line is rejected (an already-held line doesn't count)", () => {
    expect(salesOutcome(items, [{ id: "a" }, { id: "b" }]).mode).toBe("all");
  });
  it("is 'none' with no rejection and leaves items alone", () => {
    expect(salesOutcome(items, [])).toEqual({ mode: "none", items });
  });
});

describe("followsSalesRejection", () => {
  it("covers the revision opened after a rejection, and nothing else", () => {
    expect(followsSalesRejection(null, 2)).toBe(false);
    expect(followsSalesRejection({ rev_no: 1, rejected: 0 }, 2)).toBe(false);
    // Tolak on approved rev 1 -> the reopened rev 2 must be decided by a manager.
    expect(followsSalesRejection({ rev_no: 1, rejected: 1 }, 2)).toBe(true);
    // Still rev 1 (partial Tolak, never reopened): same revision.
    expect(followsSalesRejection({ rev_no: 1, rejected: 2 }, 1)).toBe(true);
    // The manager approved rev 2; a later reopen (rev 3) submits normally again.
    expect(followsSalesRejection({ rev_no: 1, rejected: 1 }, 3)).toBe(false);
  });
});
