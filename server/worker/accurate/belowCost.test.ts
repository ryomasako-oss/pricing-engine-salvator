import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { D1DatabaseShim } from "../../../scripts/d1-sqlite-shim";
import { accurateRouter } from "../routes/accurate";
import type { Env } from "../env";

/* Laporan jual di bawah beli (Ryoma, 2026-11-10): SI net price vs the PI price on the invoice date. */

interface Body {
  from: string;
  to: string;
  checked: number;
  unknownCost: number;
  below: { invoiceNo: string; net: number; cost: number; receiptNo: string; lossTotal: number }[];
}

function setup(role: string) {
  const sqlite = new DatabaseSync(":memory:");
  const dir = path.resolve(import.meta.dirname, "../../../migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(path.join(dir, f), "utf8"));
  sqlite.exec(`INSERT INTO users(id, email, name, password_hash, role) VALUES (1, 'u@x', 'U', 'x', '${role}')`);
  sqlite.exec(`INSERT INTO catalog_items(code, name, uom, list_price) VALUES ('A', 'Lakban bening', 'Pcs', 15000)`);
  sqlite.exec(`INSERT INTO accurate_items(entity, accurate_id, code, name, uom, run_id) VALUES ('PT', 1, 'A', 'Lakban bening', 'Pcs', 'r')`);
  // Bought at 10.000 on 1 Oct, 12.000 on 20 Oct.
  sqlite.exec(`INSERT INTO accurate_purchase_lines(entity, receipt_id, line_id, receipt_no, trans_date, item_code, unit, quantity,
      unit_price, unit_price_gross, inclusive_tax) VALUES
    ('PT', 1, 1, 'PI.2026.10.00001', '2026-10-01', 'A', 'Pcs', 50, 10000, 10000, 0),
    ('PT', 2, 1, 'PI.2026.10.00002', '2026-10-20', 'A', 'Pcs', 50, 12000, 12000, 0)`);
  sqlite.exec(`INSERT INTO accurate_sales_lines(entity, invoice_id, line_id, invoice_no, trans_date, customer_name, item_code,
      unit, unit_ratio, quantity, sales_amount, sub_total) VALUES
    ('PT', 1, 1, 'SI.2026.10.00001', '2026-10-05', 'MESTIKA', 'A', 'Pcs', 1, 10, 90000, 90000),
    ('PT', 2, 1, 'SI.2026.10.00002', '2026-10-06', 'MESTIKA', 'A', 'BOX', 10, 10, 110000, 110000),
    ('PT', 3, 1, 'SI.2026.10.00003', '2026-10-25', 'MESTIKA', 'A', 'Pcs', 1, 10, 100000, 100000),
    ('PT', 4, 1, 'SI.2026.09.00001', '2026-09-15', 'MESTIKA', 'A', 'Pcs', 1, 10, 50000, 50000),
    ('PT', 5, 1, 'SI.2026.11.00001', '2026-11-02', 'MESTIKA', 'A', 'Pcs', 1, 10, 10000, 10000)`);
  const app = new Hono<Env>();
  app.use(async (c, next) => {
    c.set("user", { id: 1, email: "u@x", name: "U", role } as never);
    await next();
  });
  app.route("/api/accurate", accurateRouter);
  const env = {
    DB: new D1DatabaseShim(sqlite) as unknown as D1Database,
    ACCURATE_CATALOG_ENTITY: "PT",
    ACCURATE_COGS_SOURCE: "PI",
  } as unknown as Env["Bindings"];
  const get = (qs = "") => app.request(`/api/accurate/below-cost${qs}`, {}, env);
  return { get, json: async (qs = "") => (await get(qs)).json() as Promise<Body> };
}

describe("GET /api/accurate/below-cost", () => {
  it("is closed to sales (purchase prices are cost data)", async () => {
    expect((await setup("rep").get()).status).toBe(403);
  });

  it("lists SI lines under the PI price of their own date, within the range only", async () => {
    const body = await setup("manager").json("?from=2026-10-01&to=2026-10-31");
    // SI 00001: 9.000 < 10.000. SI 00002: a BOX of 10 at 1.100 per Pcs < 10.000. SI 00003: 10.000 < 12.000 (the 20 Oct PI). Biggest loss first.
    expect(body.below.map((r) => r.invoiceNo)).toEqual(["SI.2026.10.00002", "SI.2026.10.00003", "SI.2026.10.00001"]);
    expect(body.below[2]).toMatchObject({ net: 9000, cost: 10000, receiptNo: "PI.2026.10.00001", lossTotal: 10000 });
    expect(body.below[1]).toMatchObject({ cost: 12000, lossTotal: 20000, receiptNo: "PI.2026.10.00002" });
    expect(body.checked).toBe(3);
    // SI 2026.09 and 2026.11 are outside the range.
    expect(body.unknownCost).toBe(0);
  });

  it("counts a sale before any PI as unknown, not a loss", async () => {
    const body = await setup("admin").json("?from=2026-09-01&to=2026-09-30");
    expect(body).toMatchObject({ checked: 0, unknownCost: 1, below: [] });
  });

  it("rejects bad dates and a range over a year", async () => {
    const s = setup("admin");
    expect((await s.get("?from=2026-13-01&to=2026-10-31")).status).toBe(400);
    expect((await s.get("?to=kemarin")).status).toBe(400);
    expect((await s.get("?from=2026-10-31&to=2026-10-01")).status).toBe(400);
    expect((await s.get("?from=2025-01-01&to=2026-10-31")).status).toBe(400);
  });

  it("defaults to the last 30 days", async () => {
    const body = await setup("admin").json("?to=2026-10-31");
    expect(body.from).toBe("2026-10-01");
  });
});
