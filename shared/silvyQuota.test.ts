import { describe, expect, it } from "vitest";
import { DEFAULT_QUOTA, dayStartUtc, monthStartUtc, quotaLimitsFrom, quotaVerdict } from "./silvyQuota.js";

describe("WIB period boundaries (audit_log.created_at is UTC)", () => {
  it("a day starts at 17:00 UTC the evening before", () => {
    // 2026-10-10 03:00 UTC = 10:00 WIB on the 10th → the WIB day began 2026-10-09 17:00 UTC.
    expect(dayStartUtc(new Date("2026-10-10T03:00:00Z"))).toBe("2026-10-09 17:00:00");
  });

  it("the WIB day rolls over at 17:00 UTC, not at UTC midnight", () => {
    expect(dayStartUtc(new Date("2026-10-10T16:59:59Z"))).toBe("2026-10-09 17:00:00");
    expect(dayStartUtc(new Date("2026-10-10T17:00:00Z"))).toBe("2026-10-10 17:00:00");
  });

  it("a month starts at 17:00 UTC on the last day of the previous month", () => {
    expect(monthStartUtc(new Date("2026-10-10T03:00:00Z"))).toBe("2026-09-30 17:00:00");
  });

  it("the WIB month rolls over at 17:00 UTC on the last day, matching how Indonesia sees the 1st", () => {
    expect(monthStartUtc(new Date("2026-10-31T16:59:59Z"))).toBe("2026-09-30 17:00:00");
    expect(monthStartUtc(new Date("2026-10-31T17:00:00Z"))).toBe("2026-10-31 17:00:00");
  });

  it("handles year boundaries", () => {
    expect(monthStartUtc(new Date("2026-12-31T18:00:00Z"))).toBe("2026-12-31 17:00:00");
    expect(monthStartUtc(new Date("2027-01-15T00:00:00Z"))).toBe("2026-12-31 17:00:00");
  });
});

describe("quotaLimitsFrom", () => {
  it("falls back to the defaults for missing, zero, negative, fractional or junk values", () => {
    for (const v of [undefined, "", "0", "-5", "1.5", "abc"]) {
      expect(quotaLimitsFrom({ SILVY_MONTHLY_LIMIT: v, SILVY_USER_DAILY_LIMIT: v })).toEqual(DEFAULT_QUOTA);
    }
  });
  it("reads positive integers", () => {
    expect(quotaLimitsFrom({ SILVY_MONTHLY_LIMIT: "500", SILVY_USER_DAILY_LIMIT: "20" })).toEqual({ monthly: 500, perUserDay: 20 });
  });
});

describe("quotaVerdict", () => {
  const limits = { monthly: 10, perUserDay: 3 };
  it("allows below both caps", () => {
    expect(quotaVerdict({ month: 9, userToday: 2 }, limits)).toEqual({ ok: true });
  });
  it("blocks exactly at the monthly cap, and says so before the daily message", () => {
    const v = quotaVerdict({ month: 10, userToday: 3 }, limits);
    expect(v.ok).toBe(false);
    expect(!v.ok && v.message).toMatch(/bulan ini sudah habis \(10/);
  });
  it("blocks exactly at the daily cap", () => {
    const v = quotaVerdict({ month: 4, userToday: 3 }, limits);
    expect(v.ok).toBe(false);
    expect(!v.ok && v.message).toMatch(/kuota harian.*\(3/);
  });
});
