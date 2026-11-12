import { describe, expect, it } from "vitest";
import { auditActionLabel, auditDetailText, wibRangeUtc } from "./auditLog";

describe("wibRangeUtc", () => {
  it("turns WIB days into UTC bounds, end exclusive", () => {
    expect(wibRangeUtc("2026-11-01", "2026-11-12")).toEqual(["2026-10-31 17:00:00", "2026-11-12 17:00:00"]);
  });
});

describe("auditDetailText", () => {
  it("reads before/after as old → new", () => {
    const d = JSON.stringify({ code: "A1", before: { cogs: 10000 }, after: { cogs: 12500 } });
    expect(auditDetailText(d)).toBe("COGS: 10.000 → 12.500 · code: A1");
  });
  it("falls back to raw text and clips", () => {
    expect(auditDetailText("not json")).toBe("not json");
    expect(auditDetailText("x".repeat(400), 10)).toBe(`${"x".repeat(9)}…`);
    expect(auditDetailText("")).toBe("");
  });
});

describe("auditActionLabel", () => {
  it("labels known, status_ and unknown actions", () => {
    expect(auditActionLabel("login_failed")).toBe("Gagal masuk");
    expect(auditActionLabel("status_sent")).toBe("Status: sent");
    expect(auditActionLabel("brand_new_thing")).toBe("brand new thing");
  });
});
