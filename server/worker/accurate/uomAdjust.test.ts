import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { D1DatabaseShim } from "../../../scripts/d1-sqlite-shim";
import { accurateRouter } from "../routes/accurate";
import type { Env } from "../env";

/* Stock UOM Adjustment (Ryoma, 2026-11-17): a ratio set in the app makes SI and PI compare per the same
   base unit on every cost page, and apply-cogs can price a PI unit Accurate has no ratio for. */

function setup(role: string) {
  const sqlite = new DatabaseSync(":memory:");
  const dir = path.resolve(import.meta.dirname, "../../../migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(path.join(dir, f), "utf8"));
  sqlite.exec(`INSERT INTO users(id, email, name, password_hash, role) VALUES (1, 'u@x', 'U', 'x', '${role}')`);
  // Base KG. Sold per PAK, which Accurate has no ratio for (it sends 1). Bought per KG, then per KTK (no ratio either).
  sqlite.exec(`INSERT INTO catalog_items(code, name, uom, cogs, list_price) VALUES ('A', 'Plastik sampah', 'KG', 20000, 30000)`);
  sqlite.exec(`INSERT INTO accurate_items(entity, accurate_id, code, name, uom, run_id) VALUES ('PT', 1, 'A', 'Plastik sampah', 'KG', 'r')`);
  sqlite.exec(`INSERT INTO accurate_purchase_lines(entity, receipt_id, line_id, receipt_no, trans_date, item_code, unit, quantity,
      unit_price, unit_price_gross, inclusive_tax) VALUES
    ('PT', 1, 1, 'PI.1', '2026-10-01', 'A', 'KG', 50, 20000, 20000, 0),
    ('PT', 2, 1, 'PI.2', '2026-11-01', 'A', 'KTK', 5, 400000, 400000, 0)`);
  sqlite.exec(`INSERT INTO accurate_sales_lines(entity, invoice_id, line_id, invoice_no, trans_date, customer_name, item_code,
      unit, unit_ratio, quantity, sales_amount, sub_total) VALUES
    ('PT', 1, 1, 'SI.1', '2026-10-05', 'PRIMA', 'A', 'PAK', 1, 2, 30000, 30000)`);
  sqlite.exec(`INSERT INTO accurate_purchase_state(entity, last_pass_at) VALUES ('PT', '2026-11-02T00:00:00Z')`);
  const app = new Hono<Env>();
  app.use(async (c, next) => {
    c.set("user", { id: 1, email: "u@x", name: "U", role } as never);
    await next();
  });
  app.route("/api/accurate", accurateRouter);
  const env = { DB: new D1DatabaseShim(sqlite) as unknown as D1Database, ACCURATE_CATALOG_ENTITY: "PT", ACCURATE_COGS_SOURCE: "PI" } as unknown as Env["Bindings"];
  const req = (p: string, init: RequestInit = {}) => app.request(`/api/accurate${p}`, init, env);
  const put = (body: unknown) => req("/uom-adjustments", { method: "PUT", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
  const report = async () => (await (await req("/below-cost?from=2026-10-01&to=2026-10-31")).json()) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
  const cogs = async () => (await (await req("/apply-cogs", { method: "POST", body: "{}", headers: { "content-type": "application/json" } })).json()) as any;
  return { req, put, report, cogs, sqlite };
}

describe("Stock UOM Adjustment", () => {
  it("is closed to sales: no list, no write", async () => {
    const s = setup("rep");
    expect((await s.req("/uom-adjustments")).status).toBe(403);
    expect((await s.put({ code: "A", uom: "PAK", factor: 0.5 })).status).toBe(403);
    expect((await s.req("/uom-adjustments?code=A&uom=PAK", { method: "DELETE" })).status).toBe(403);
  });

  it("rejects a zero ratio, the base unit and an unknown item", async () => {
    const s = setup("manager");
    expect((await s.put({ code: "A", uom: "PAK", factor: 0 })).status).toBe(400);
    expect((await s.put({ code: "A", uom: "kg", factor: 2 })).status).toBe(400);
    expect((await s.put({ code: "ZZZ", uom: "PAK", factor: 2 })).status).toBe(404);
  });

  it("a ratio under 1 puts SI and PI head to head, and shows on Jual < Beli", async () => {
    const s = setup("manager");
    const before = await s.report();
    expect(before.uomDiff[0]).toMatchObject({ invoiceNo: "SI.1", siUnit: "PAK", siRatio: null, net: null, cost: 20000 });
    // Ratio 1 makes it 15.000 "per KG": a loss that is really a missing ratio, marked as such.
    expect(before.below).toEqual([expect.objectContaining({ invoiceNo: "SI.1", net: 15000 })]);
    expect(before.below[0].hints.map((h: { kind: string }) => h.kind)).toContain("sale_unit");

    expect((await s.put({ code: "A", uom: "PAK", factor: 0.5, note: "cek gudang" })).status).toBe(200);
    const after = await s.report();
    // 2 PAK = 1 KG for 30.000: 30.000 per KG, above the 20.000 PI.
    expect(after.uomDiff[0]).toMatchObject({ siRatio: 0.5, net: 30000, cost: 20000 });
    expect(after.below).toEqual([]);

    await s.put({ code: "A", uom: "PAK", factor: 5 }); // 2 PAK = 10 KG for 30.000: 3.000 per KG, under cost
    const loss = await s.report();
    expect(loss.uomDiff[0]).toMatchObject({ siRatio: 5, net: 3000 });
    expect(loss.below).toEqual([expect.objectContaining({ invoiceNo: "SI.1", net: 3000, cost: 20000 })]);
    expect(loss.below[0].hints.map((h: { kind: string }) => h.kind)).not.toContain("sale_unit");

    const list = (await (await s.req("/uom-adjustments")).json()) as { adjustments: unknown[] };
    expect(list.adjustments).toEqual([expect.objectContaining({ code: "A", uom: "PAK", factor: 5, updatedBy: "U" })]);
    expect(s.sqlite.prepare("SELECT action FROM audit_log ORDER BY id").all().map((r) => r.action)).toEqual(["uom_adjusted", "uom_adjusted"]);
  });

  it("apply-cogs prices a PI unit once its ratio is adjusted, and deleting it undoes that", async () => {
    const s = setup("manager");
    expect((await s.cogs()).skipped).toEqual([expect.objectContaining({ code: "A", reason: "unknown_unit" })]);
    await s.put({ code: "A", uom: "KTK", factor: 16 }); // 400.000 per KTK of 16 KG = 25.000 per KG
    expect((await s.cogs()).changed).toEqual([expect.objectContaining({ code: "A", from: 20000, to: 25000, receiptNo: "PI.2" })]);
    expect((await s.req("/uom-adjustments?code=A&uom=KTK", { method: "DELETE" })).status).toBe(200);
    expect((await s.cogs()).skipped).toEqual([expect.objectContaining({ code: "A", reason: "unknown_unit" })]);
    expect((await s.req("/uom-adjustments?code=A&uom=KTK", { method: "DELETE" })).status).toBe(404);
  });
});
