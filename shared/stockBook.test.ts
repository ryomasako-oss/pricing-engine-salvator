import { describe, expect, it } from "vitest";
import { buildBook, type BookCount } from "./stockBook";

const c = (code: string, warehouse: string, owner: BookCount["owner"], counted: number, at = "2026-11-25 10:00:00"): BookCount =>
  ({ code, name: code, uom: "PCS", warehouse, owner, counted, counted_at: at, counted_by_name: "Paulina" });

describe("buildBook", () => {
  it("one column per warehouse + owner, total of all, and Accurate PT only for the counted Umum/PT warehouses", () => {
    const { columns, rows } = buildBook(
      [c("LEM", "Utama", "umum", 48), c("LEM", "GUDANG AKR SURABAYA", "umum", 25, "2026-11-25 11:00:00"), c("LEM", "Utama", "cv", 10)],
      [{ code: "LEM", warehouse: "Utama", qty: 50 }, { code: "LEM", warehouse: "GUDANG AKR SURABAYA", qty: 25 }, { code: "LEM", warehouse: "GUDANG PALEMBANG", qty: 7 }],
    );
    expect(columns.map((x) => x.key)).toEqual(["Utama|umum", "Utama|cv", "GUDANG AKR SURABAYA|umum"]);
    expect(rows[0]).toMatchObject({ total: 83, accurate: 75, accurateAll: 82, diff: -2, lastAt: "2026-11-25 11:00:00" });
  });

  it("only CV counted: nothing to compare; a count without warehouse is not compared either", () => {
    const { rows } = buildBook([c("A", "Utama", "cv", 4), c("B", "", "umum", 9)], [{ code: "A", warehouse: "Utama", qty: 1 }, { code: "B", warehouse: "Utama", qty: 3 }]);
    expect(rows.map((r) => [r.code, r.accurate, r.diff])).toEqual([["A", null, null], ["B", null, null]]);
  });
});
