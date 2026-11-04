import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { D1DatabaseShim } from "../../scripts/d1-sqlite-shim";
import { catalogRouter } from "./routes/catalog";
import { normalizeText } from "../../shared/match";
import type { Env } from "./env";

/* Ryoma, 2026-11-04: a client's wording that the sales team already invoiced (Accurate sales
   invoices) matches that item. Through the real POST /api/catalog/match. */
function freshDb() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = path.resolve(import.meta.dirname, "../../migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(path.join(dir, f), "utf8"));
  sqlite.exec(`INSERT INTO users(id, email, name, password_hash, role) VALUES (1, 'm@x', 'M', 'x', 'manager')`);
  sqlite.exec(`INSERT INTO clients(id, name, code, accurate_customer_no) VALUES (1, 'PT Mestika', 'MMP', 'C.00030'), (2, 'PT Lain', 'LN', '')`);
  sqlite.exec(`INSERT INTO catalog_items(code, name, uom, cogs, list_price) VALUES
    ('100003', 'SPIVA MINERAL WATER 500ML', 'BTL', 5000, 8000), ('100002', 'SPIVA MINERAL WATER 330ML', 'BTL', 4000, 6000)`);
  const k = normalizeText("Aqua botol kecil dus");
  sqlite.exec(`INSERT INTO accurate_sales_lines(entity, invoice_id, line_id, invoice_no, trans_date, customer_no, item_code, detail_name, name_key) VALUES
    ('PT', 1, 1, 'SI.1', '2026-10-01', 'C.00030', '100002', 'Aqua botol kecil dus', '${k}'),
    ('PT', 2, 1, 'SI.2', '2026-10-02', 'C.00099', '100003', 'Aqua botol kecil dus', '${k}'),
    ('PT', 3, 1, 'SI.3', '2026-10-03', 'C.00098', '100003', 'Aqua botol kecil dus', '${k}')`);
  return { sqlite, db: new D1DatabaseShim(sqlite) as unknown as D1Database };
}

async function match(db: D1Database, clientId: number | null, enabled = "true") {
  const a = new Hono<Env>();
  a.use(async (c, next) => {
    c.set("user", { id: 1, email: "m@x", name: "M", role: "manager" } as never);
    await next();
  });
  a.route("/api/catalog", catalogRouter);
  const env = { DB: db, ACCURATE_SALES_ENABLED: enabled } as unknown as Env["Bindings"];
  const res = await a.request("/api/catalog/match", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: clientId, lines: [{ name: "Aqua botol kecil dus", qty: 2 }] }),
  }, env);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { results: { status: string; via: string; candidates: { id: number }[] }[]; items: { id: number; code: string }[] };
  const r = body.results[0];
  return { status: r.status, via: r.via, code: body.items.find((i) => i.id === r.candidates[0]?.id)?.code };
}

describe("POST /api/catalog/match by sales-invoice wording", () => {
  it("a client linked to its Accurate customer gets the item it was invoiced, settled", async () => {
    expect(await match(freshDb().db, 1)).toEqual({ status: "match", via: "si", code: "100002" });
  });

  it("a client without a link gets the item it was invoiced as most often, to check", async () => {
    expect(await match(freshDb().db, 2)).toEqual({ status: "review", via: "si", code: "100003" });
    expect(await match(freshDb().db, null)).toEqual({ status: "review", via: "si", code: "100003" });
  });

  it("while the sales sync is off, matching is by name as before", async () => {
    expect((await match(freshDb().db, 1, "false")).via).not.toBe("si");
  });
});
