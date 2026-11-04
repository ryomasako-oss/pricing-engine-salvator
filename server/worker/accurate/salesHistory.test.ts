import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { D1DatabaseShim } from "../../../scripts/d1-sqlite-shim";
import { accurateRouter } from "../routes/accurate";
import type { Env } from "../env";

interface Body {
  total: number;
  cards: {
    code: string;
    baseUom: string;
    sales: { invoiceNo: string; customerName: string; detailName: string; price: number | null; perBase: number | null }[];
    names: { name: string; count: number }[];
  }[];
}

function setup(role: string) {
  const sqlite = new DatabaseSync(":memory:");
  const dir = path.resolve(import.meta.dirname, "../../../migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(path.join(dir, f), "utf8"));
  const db = new D1DatabaseShim(sqlite) as unknown as D1Database;
  sqlite.exec(`INSERT INTO users(id, email, name, password_hash, role) VALUES (1, 'u@x', 'U', 'x', '${role}')`);
  sqlite.exec(`INSERT INTO catalog_items(code, name, uom, cogs, list_price, stock) VALUES
    ('S1', 'Spiva 500ML', 'BTL', 5000, 7000, 0),
    ('K1', 'Kertas HVS A4 100%', 'Rim', 40000, 50000, 0),
    ('N1', 'Belum pernah dijual', 'Pcs', 1000, 2000, 0)`);
  sqlite.exec(`INSERT INTO accurate_items(entity, accurate_id, code, name, uom, units, run_id) VALUES
    ('PT', 1, 'S1', 'Spiva 500ML', 'BTL', '[{"uom":"BOX","factor":24}]', 'r')`);
  sqlite.exec(`INSERT INTO accurate_sales_lines(entity, invoice_id, line_id, invoice_no, trans_date, customer_no, customer_name,
      item_code, detail_name, unit, unit_ratio, quantity, return_qty, sales_amount, inclusive_tax, tax_rate, cash_discount, sub_total) VALUES
    ('PT', 1, 1, 'SI.2026.10.00297', '2026-10-20', 'C.00030', 'PT Agro', 'S1', 'Air mineral botol 500', 'BOX', 24, 16, 0, 2504000, 0, 11, 0, 2504000),
    ('PT', 2, 1, 'SI.2026.09.00010', '2026-09-01', 'C.00031', 'CV Baja', 'S1', 'Spiva 500ML', 'BTL', 1, 10, 0, 70000, 0, 11, 7000, 70000),
    ('PT', 3, 1, 'SI.2026.09.00011', '2026-09-02', 'C.00031', 'CV Baja', 'S1', 'Spiva 500ML', 'BTL', 1, 5, 5, 35000, 0, 11, 0, 35000),
    ('PT', 4, 1, 'SI.2026.10.00300', '2026-10-25', 'C.00031', 'CV Baja', 'K1', 'kertas 100% putih', 'Rim', 1, 2, 0, 100000, 0, 11, 0, 100000),
    ('PT', 5, 1, 'SI.2026.10.00301', '2026-10-26', 'C.00031', 'CV Baja', 'X9', 'Bukan barang katalog', 'Pcs', 1, 1, 0, 1000, 0, 11, 0, 1000)`);
  const app = new Hono<Env>();
  app.use(async (c, next) => {
    c.set("user", { id: 1, email: "u@x", name: "U", role } as never);
    await next();
  });
  app.route("/api/accurate", accurateRouter);
  const env = { DB: db, ACCURATE_CATALOG_ENTITY: "PT" } as unknown as Env["Bindings"];
  const get = (qs = "") => app.request(`/api/accurate/sales-history${qs}`, {}, env);
  const json = async (qs = ""): Promise<Body> => (await get(qs)).json() as Promise<Body>;
  return { get, json };
}

describe("GET /api/accurate/sales-history", () => {
  it("is closed to sales, like Riwayat COGS", async () => {
    const { get } = setup("rep");
    expect((await get()).status).toBe(403);
  });

  it("lists sold catalog items, most recently sold first, lines newest first", async () => {
    const { json } = setup("manager");
    const body = await json();
    // N1 was never sold; X9 is not in the catalog.
    expect(body.cards.map((c) => c.code)).toEqual(["K1", "S1"]);
    expect(body.total).toBe(2);
    // K1 has no Accurate item record: prices are per its catalog unit, not a made-up Pcs.
    expect(body.cards[0].baseUom).toBe("Rim");
    const s1 = body.cards[1];
    expect(s1.baseUom).toBe("BTL");
    expect(s1.sales.map((s) => s.invoiceNo)).toEqual(["SI.2026.10.00297", "SI.2026.09.00011", "SI.2026.09.00010"]);
  });

  it("prices each line net per invoice unit and per base unit, after the invoice discount", async () => {
    const { json } = setup("manager");
    const s1 = (await json()).cards.find((c) => c.code === "S1")!;
    // 16 BOX for 2.504.000 → 156.500 per BOX, 6.520,83 per BTL.
    expect(s1.sales[0]).toMatchObject({ price: 156500, perBase: 6520.83 });
    // Fully returned: no price.
    expect(s1.sales[1]).toMatchObject({ price: null, perBase: null });
    // 10% invoice discount: 7.000 → 6.300.
    expect(s1.sales[2]).toMatchObject({ price: 6300, perBase: 6300 });
  });

  it("finds an item by the wording it was invoiced under, and lists those wordings", async () => {
    const { json } = setup("manager");
    const body = await json("?q=air%20mineral");
    expect(body.cards.map((c) => c.code)).toEqual(["S1"]);
    expect(body.cards[0].names).toEqual([
      { name: "Spiva 500ML", count: 2 },
      { name: "Air mineral botol 500", count: 1 },
    ]);
  });

  it("searches code, catalog name and customer, treating % and _ as plain text", async () => {
    const { json } = setup("manager");
    expect((await json("?q=S1")).cards.map((c) => c.code)).toEqual(["S1"]);
    expect((await json("?q=agro")).cards.map((c) => c.code)).toEqual(["S1"]);
    expect((await json("?q=baja")).cards.map((c) => c.code)).toEqual(["K1", "S1"]);
    expect((await json("?q=100%25")).cards.map((c) => c.code)).toEqual(["K1"]);
    expect((await json("?q=belum")).total).toBe(0);
  });
});
