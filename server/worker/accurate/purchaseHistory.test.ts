import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { D1DatabaseShim } from "../../../scripts/d1-sqlite-shim";
import { accurateRouter } from "../routes/accurate";
import type { Env } from "../env";

/* Riwayat pembelian (PI): the purchase-side twin of Riwayat SI, read-only and closed to sales. */

interface Body {
  total: number;
  cards: { code: string; purchases: { invoiceNo: string; invoicePrice: number; price: number; inclusiveTax: boolean }[] }[];
}

function setup(role: string) {
  const sqlite = new DatabaseSync(":memory:");
  const dir = path.resolve(import.meta.dirname, "../../../migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(path.join(dir, f), "utf8"));
  sqlite.exec(`INSERT INTO users(id, email, name, password_hash, role) VALUES (1, 'u@x', 'U', 'x', '${role}')`);
  sqlite.exec(`INSERT INTO catalog_items(code, name, uom) VALUES ('A', 'Lakban bening', 'Roll'), ('B', 'Kertas A4', 'Rim'), ('N', 'Belum pernah dibeli', 'Pcs')`);
  // PI.2025.11.00024: 10% item discount, "termasuk PPN": 85.470 on the PI, modal 69.300 (accurate/mapping.ts).
  sqlite.exec(`INSERT INTO accurate_purchase_lines(entity, receipt_id, line_id, receipt_no, trans_date, item_code, unit, quantity,
      unit_price, unit_price_gross, inclusive_tax) VALUES
    ('PT', 1, 1, 'PI.2025.11.00024', '2025-11-10', 'A', 'Roll', 27, 69300, 85470, 1),
    ('PT', 2, 1, 'PI.2026.10.00100', '2026-10-01', 'A', 'Roll', 10, 70000, 70000, 0),
    ('PT', 3, 1, 'PI.2026.09.00050', '2026-09-01', 'B', 'Rim', 5, 40000, 40000, 0),
    ('PT', 4, 1, 'PI.2026.10.00101', '2026-10-02', 'X9', 'Pcs', 1, 100, 100, 0)`);
  const app = new Hono<Env>();
  app.use(async (c, next) => {
    c.set("user", { id: 1, email: "u@x", name: "U", role } as never);
    await next();
  });
  app.route("/api/accurate", accurateRouter);
  const env = { DB: new D1DatabaseShim(sqlite) as unknown as D1Database, ACCURATE_CATALOG_ENTITY: "PT" } as unknown as Env["Bindings"];
  const get = (qs = "") => app.request(`/api/accurate/purchase-history${qs}`, {}, env);
  return { get, json: async (qs = "") => (await get(qs)).json() as Promise<Body> };
}

describe("GET /api/accurate/purchase-history", () => {
  it("is closed to sales (purchase prices are cost data)", async () => {
    expect((await setup("rep").get()).status).toBe(403);
  });

  it("lists bought catalog items, most recently bought first, newest PI first, invoice price and modal apart", async () => {
    const body = await setup("manager").json();
    // N was never bought; X9 is not in the catalog.
    expect(body.total).toBe(2);
    expect(body.cards.map((c) => c.code)).toEqual(["A", "B"]);
    expect(body.cards[0].purchases.map((p) => p.invoiceNo)).toEqual(["PI.2026.10.00100", "PI.2025.11.00024"]);
    expect(body.cards[0].purchases[1]).toMatchObject({ invoicePrice: 85470, price: 69300, inclusiveTax: true });
  });

  it("finds an item by its PI number", async () => {
    const body = await setup("admin").json("?q=" + encodeURIComponent("PI.2026.09"));
    expect(body.cards.map((c) => c.code)).toEqual(["B"]);
  });
});
