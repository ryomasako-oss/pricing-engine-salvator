import { describe, expect, it } from "vitest";
import { missingTerms, paymentLabel, splitPaymentTerms, warrantyLabel } from "./terms";

describe("splitPaymentTerms", () => {
  it("takes the leading number of days and keeps the rest as a note", () => {
    expect(splitPaymentTerms("30 hari setelah invoice")).toEqual({ days: 30, note: "setelah invoice" });
    expect(splitPaymentTerms(" 45 HARI ")).toEqual({ days: 45, note: "" });
  });
  it("has no days when the text doesn't start with them", () => {
    expect(splitPaymentTerms("COD")).toEqual({ days: null, note: "COD" });
    expect(splitPaymentTerms("")).toEqual({ days: null, note: "" });
    expect(splitPaymentTerms(undefined)).toEqual({ days: null, note: "" });
  });
});

describe("paymentLabel", () => {
  it("states days, then the note", () => {
    expect(paymentLabel({ paymentDays: 30, payment: "setelah invoice" })).toBe("30 hari setelah invoice");
    expect(paymentLabel({ paymentDays: 14, payment: "" })).toBe("14 hari");
    expect(paymentLabel({ paymentDays: 0, payment: "" })).toBe("Tunai (0 hari)");
  });
  it("falls back to the old free text for quotes made before the field existed", () => {
    expect(paymentLabel({ payment: "30 hari setelah invoice" })).toBe("30 hari setelah invoice");
    expect(paymentLabel({ paymentDays: null, payment: "" })).toBe("");
  });
});

describe("warrantyLabel", () => {
  it("states years with an Indonesian decimal comma, and none for 0", () => {
    expect(warrantyLabel({ warrantyYears: 1 })).toBe("1 tahun");
    expect(warrantyLabel({ warrantyYears: 0.5 })).toBe("0,5 tahun");
    expect(warrantyLabel({ warrantyYears: 0 })).toBe("Tanpa garansi");
    expect(warrantyLabel({ warrantyYears: 2, warrantyNote: "servis gratis" })).toBe("2 tahun (servis gratis)");
  });
  it("is empty when not set", () => {
    expect(warrantyLabel({})).toBe("");
    expect(warrantyLabel({ warrantyYears: null })).toBe("");
  });
});

describe("missingTerms", () => {
  it("lists what is missing; 0 counts as set (cash / no warranty)", () => {
    expect(missingTerms({})).toEqual(["Term of payment (hari)", "Garansi (tahun)"]);
    expect(missingTerms(undefined)).toHaveLength(2);
    expect(missingTerms({ paymentDays: 0, warrantyYears: 0 })).toEqual([]);
    expect(missingTerms({ paymentDays: 30, warrantyYears: null })).toEqual(["Garansi (tahun)"]);
  });
});
