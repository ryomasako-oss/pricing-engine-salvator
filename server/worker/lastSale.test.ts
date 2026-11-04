import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { D1DatabaseShim } from "../../scripts/d1-sqlite-shim";
import { catalogRouter } from "./routes/catalog";
import { clientsRouter } from "./routes/clients";
import { lineFromCatalog } from "../../shared/match";
import type { CatalogItem } from "../../shared/types";
import type { Env } from "./env";

/** Plafon dari SI terakhir (Ryoma, 2026-11-04): to this client first, then to anyone; never under COGS. */
function freshDb() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = path.resolve(import.meta.dirname, "../../migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(path.join(dir, f), "utf8"));
  sqlite.exec(`INSERT INTO users(id, email, name, password_hash, role) VALUES (1, 'm@x', 'M', 'x', 'manager')`);
  sqlite.exec(`INSERT INTO clients(id, name, code, accurate_customer_no) VALUES (1, 'PT Mestika', 'MMP', 'C.00030'), (2, 'PT Baru', 'BR', '')`);
  sqlite.exec(`INSERT INTO catalog_items(code, name, uom, cogs, list_price) VALUES
    ('100003', 'SPIVA MINERAL WATER 500ML', 'BTL', 5000, 8000),
    ('B1', 'SPIDOL WHITEBOARD SNOWMAN HITAM', 'Pcs', 5000, 8000),
    ('U1', 'TISSUE PASEO', 'Pak', 10000, 15000)`);
  sqlite.exec(`INSERT INTO accurate_items(entity, accurate_id, code, name, uom, units, run_id) VALUES
    ('PT', 1, '100003', 'Spiva', 'BTL', '[{"uom":"BOX","factor":24}]', 'r'), ('PT', 2, 'B1', 'Spidol', 'PCS', '[]', 'r'),
    ('PT', 3, 'U1', 'Tissue', 'PCS', '[]', 'r')`);
  const si = (id: number, no: string, date: string, cust: string, code: string, ratio: number, qty: number, amount: number) =>
    `('PT', ${id}, 1, '${no}', '${date}', '${cust}', '${code}', ${ratio}, ${qty}, ${amount}, ${amount})`;
  sqlite.exec(`INSERT INTO accurate_sales_lines(entity, invoice_id, line_id, invoice_no, trans_date, customer_no, item_code,
                 unit_ratio, quantity, sales_amount, sub_total) VALUES
    ${si(10, "SI.OWN.OLD", "2026-03-01", "C.00030", "100003", 24, 1, 144000)},
    ${si(11, "SI.OWN", "2026-09-01", "C.00030", "100003", 24, 16, 2504000)},
    ${si(12, "SI.OTHER.NEWER", "2026-10-26", "C.00099", "100003", 1, 10, 70000)},
    ${si(20, "SI.B1.LOSS", "2026-10-20", "C.00030", "B1", 1, 10, 40000)},
    ${si(21, "SI.B1.OTHER", "2026-10-01", "C.00099", "B1", 1, 10, 65000)},
    ${si(30, "SI.U1", "2026-10-01", "C.00030", "U1", 1, 1, 20000)},
    ${si(40, "SI.TOO.OLD", "2025-06-01", "C.00030", "100003", 1, 1, 99999)}`);
  return { sqlite, db: new D1DatabaseShim(sqlite) as unknown as D1Database };
}

function app(db: D1Database, over: Record<string, string> = {}) {
  const a = new Hono<Env>();
  a.use(async (c, next) => {
    c.set("user", { id: 1, email: "m@x", name: "M", role: "manager" } as never);
    await next();
  });
  a.route("/api/catalog", catalogRouter);
  a.route("/api/clients", clientsRouter);
  const env = { DB: db, ACCURATE_SALES_ENABLED: "true", ...over } as unknown as Env["Bindings"];
  const send = (method: string, p: string, body: unknown) =>
    a.request(p, { method, body: JSON.stringify(body), headers: { "content-type": "application/json" } }, env);
  return { post: (p: string, b: unknown) => send("POST", p, b), put: (p: string, b: unknown) => send("PUT", p, b) };
}

const lines = [
  { name: "SPIVA MINERAL WATER 500ML", code: "100003", qty: 1 },
  { name: "SPIDOL WHITEBOARD SNOWMAN HITAM", code: "B1", qty: 1 },
  { name: "TISSUE PASEO", code: "U1", qty: 1 },
];

async function lastSaleOf(db: D1Database, clientId: number | null, over: Record<string, string> = {}) {
  const res = await app(db, over).post("/api/catalog/match", { client_id: clientId, lines });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { items: CatalogItem[] };
  return Object.fromEntries(body.items.map((i) => [i.code, i.last_sale ?? null]));
}

describe("POST /api/catalog/match: last_sale", () => {
  it("prefers this client's latest invoice, per base unit, within 12 months", async () => {
    const { db } = freshDb();
    const s = await lastSaleOf(db, 1);
    // 2.504.000 / (16 x 24) = 6.520,83 per BTL, though another client was invoiced later.
    expect(s["100003"]).toEqual({ price: 6520.83, invoiceNo: "SI.OWN", date: "2026-09-01", ownClient: true });
  });

  it("passes over a price under COGS, and falls back to any client", async () => {
    const { db } = freshDb();
    // B1: the client paid 4.000 < COGS 5.000 (a loss); the other client's 6.500 is used.
    expect((await lastSaleOf(db, 1))["B1"]).toEqual({ price: 6500, invoiceNo: "SI.B1.OTHER", date: "2026-10-01", ownClient: false });
  });

  it("a client without an Accurate customer number gets the latest invoice to anyone", async () => {
    const { db } = freshDb();
    expect((await lastSaleOf(db, 2))["100003"]).toMatchObject({ invoiceNo: "SI.OTHER.NEWER", price: 7000, ownClient: false });
  });

  it("nothing for an item whose catalog unit isn't Accurate's base unit, or while the sales sync is off", async () => {
    const { db } = freshDb();
    expect((await lastSaleOf(db, 1))["U1"]).toBeNull();
    expect(Object.values(await lastSaleOf(db, 1, { ACCURATE_SALES_ENABLED: "false" }))).toEqual([null, null, null]);
  });
});

describe("lineFromCatalog: the ceiling", () => {
  const item = { id: 1, code: "100003", name: "Spiva", uom: "BTL", cogs: 5000, list_price: 8000, units: [{ uom: "BOX", factor: 24 }] } as CatalogItem;
  const sale = { price: 6520.83, invoiceNo: "SI.OWN", date: "2026-09-01", ownClient: true };

  it("is the last sale price, then the list price; a price in the client's own file still wins", () => {
    expect(lineFromCatalog({ ...item, last_sale: sale }, 1).rrp).toBe(6521);
    expect(lineFromCatalog(item, 1).rrp).toBe(8000);
    expect(lineFromCatalog({ ...item, last_sale: sale }, 1, { rrp: 7000 }).rrp).toBe(7000);
  });

  it("converts the per-BTL sale price to the line's unit", () => {
    expect(lineFromCatalog({ ...item, last_sale: sale }, 1, { uom: "BOX" }).rrp).toBe(6521 * 24);
  });
});

describe("clients: Accurate customer number", () => {
  it("is saved with the client and trimmed", async () => {
    const { sqlite, db } = freshDb();
    const res = await app(db).put("/api/clients/2", { name: "PT Baru", accurate_customer_no: " C.00123 " });
    expect(res.status).toBe(200);
    expect(sqlite.prepare("SELECT accurate_customer_no AS no FROM clients WHERE id = 2").get()).toEqual({ no: "C.00123" });
  });
});
