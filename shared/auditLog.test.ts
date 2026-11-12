import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
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
    expect(auditDetailText(d)).toBe("COGS: 10.000 → 12.500 · Kode: A1");
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
