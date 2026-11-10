import { describe, expect, it } from "vitest";
import { fmtDateTime, pct, toNum } from "./format";

describe("toNum", () => {
  it.each([
    ["Rp. 15.000", 15000],
    ["Rp 15.000,-", 15000],
    ["15.000,-", 15000],
    ["15.000.-", 15000],
    ["IDR 15.000", 15000],
    ["rp15.000", 15000],
    ["Rp. 1.500.000", 1500000],
  ])("reads the rupiah format %j", (input, want) => {
    expect(toNum(input)).toBe(want);
  });

  it.each([
    [15000, 15000],
    ["15.000", 15000],
    ["1.500.000", 1500000],
    ["15,000", 15000],
    ["15.000,50", 15000.5],
    ["-15.000", -15000],
    ["Rp 15.000", 15000],
    ["-Rp 15.000", -15000],
    ["2.5", 2.5],
    ["2,5", 2.5],
  ])("still reads %j", (input, want) => {
    expect(toNum(input)).toBe(want);
  });

  it.each(["", "-", "abc", null, undefined, Infinity])("gives NaN for %j", (input) => {
    expect(toNum(input)).toBeNaN();
  });
});

describe("fmtDateTime", () => {
  it("reads a SQLite timestamp as UTC, like an ISO one", () => {
    expect(fmtDateTime("2026-11-08 15:31:00")).toBe(fmtDateTime("2026-11-08T15:31:00Z"));
    expect(fmtDateTime("2026-11-08 15:31")).toBe(fmtDateTime("2026-11-08T15:31:00Z"));
  });
});

describe("pct", () => {
  it("writes a negative with the true minus sign, like rp()", () => {
    expect(pct(-0.125)).toBe("−12,5%");
    expect(pct(0.125)).toBe("12,5%");
    expect(pct(-0.00001)).toBe("0,0%");
  });
});
