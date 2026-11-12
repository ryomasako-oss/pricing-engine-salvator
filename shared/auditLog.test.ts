import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { auditActionLabel, auditDetailText, wibRangeUtc } from "./auditLog";

// Every top-level detail key in production audit_log on 2026-11-13 (json_each over detail), plus keys audit() calls write that prod has not seen yet.
const PROD_KEYS = (
  "code name cogs uom list_price category units entity number changed title targets restart rows silvy recipients date " +
  "status reservationId phase question codes added unchanged skipped receiptsThrough noReceipt source version updated to " +
  "held from_status client_id note newItems mode inserted feedback count reason net_margin monthly_value breaches transDate " +
  "receiptNo from role email created open counts closed unitRows unitMismatch stockApplied insertNew quote_id minNetMargin " +
  "minLineMargin maxBasketDiscount draft_id approvalValueThreshold allowBelowCost rev_no kind active via password error " +
  "cogsFromPurchases by telegram_phone skipped_for_manual_check reset_to_zero priority phone from_rev excluded deleted backup " +
  "ip offset indexed next removed tag row_id action"
).split(" ");

describe("wibRangeUtc", () => {
  it("turns WIB days into UTC bounds, end exclusive", () => {
    expect(wibRangeUtc("2026-11-01", "2026-11-12")).toEqual(["2026-10-31 17:00:00", "2026-11-12 17:00:00"]);
  });
});

describe("auditDetailText", () => {
  it("reads before/after as old → new", () => {
    const d = JSON.stringify({ code: "A1", before: { cogs: 10000 }, after: { cogs: 12500 } });
    expect(auditDetailText(d)).toBe("COGS: 10.000 → 12.500 · Kode: A1");
  });
  it("labels import counts and shows booleans as Ya/Tidak", () => {
    const d = JSON.stringify({ source: "x.xlsx", mode: "merge", rows: 27, inserted: 1, updated: 26, cogsFromPurchases: 1 });
    expect(auditDetailText(d)).toBe("Sumber: x.xlsx · Mode: merge · Baris: 27 · Baru: 1 · Diperbarui: 26 · COGS dari pembelian: 1");
    expect(auditDetailText(JSON.stringify({ allowBelowCost: false, restart: true }))).toBe("Boleh di bawah COGS: Tidak · Ulang dari awal: Ya");
  });
  it.each(PROD_KEYS)("labels detail key %s", (k) => {
    expect(auditDetailText(JSON.stringify({ [k]: 1 }))).not.toMatch(new RegExp(`^${k}:`));
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

describe("every action the server writes has a label", () => {
  // Scans audit(..., "action") calls and raw INSERTs, so a new action can't reach the page as raw text unnoticed.
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") ? [join(dir, e.name)] : [],
    );
  const actions = new Set<string>();
  for (const f of files("server")) {
    const src = readFileSync(f, "utf8");
    // audit(db, actor, "entity", id, "action" | cond ? "a" : "b", ...)
    for (const m of src.matchAll(/\baudit\(\s*[^,]+,\s*[^,]+,\s*"[a-z_]+",\s*[^,]+,\s*(?:"([a-z_]+)"|[^,?]+\?\s*"([a-z_]+)"\s*:\s*"([a-z_]+)")/g)) {
      [m[1], m[2], m[3]].forEach((a) => a && actions.add(a));
    }
    for (const m of src.matchAll(/INSERT INTO audit_log[\s\S]{0,200}?'catalog', [\w.]+, '([a-z_]+)'/g)) actions.add(m[1]);
  }
  it("finds the actions", () => expect(actions.size).toBeGreaterThan(30));
  it.each([...actions])("%s", (a) => expect(auditActionLabel(a)).not.toBe(a.replace(/_/g, " ")));
});
