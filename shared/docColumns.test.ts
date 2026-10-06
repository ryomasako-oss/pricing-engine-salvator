import { describe, expect, it } from "vitest";
import { docColumns } from "./docColumns";

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
