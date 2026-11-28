import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { D1DatabaseShim } from "../../scripts/d1-sqlite-shim";
import { priceLettersRouter } from "./routes/priceLetters";
import type { Env } from "./env";

/* 2026-11-26: surat perubahan harga untuk SI yang benar-benar rugi, draft lalu ACC orang lain. */

type Role = "rep" | "manager" | "manager2" | "admin";
const USERS: Record<Role, { id: number; role: string }> = {
  rep: { id: 1, role: "rep" }, manager: { id: 2, role: "manager" }, manager2: { id: 3, role: "manager" }, admin: { id: 4, role: "admin" },
};

function setup() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = path.resolve(import.meta.dirname, "../../migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(path.join(dir, f), "utf8"));
  for (const [name, u] of Object.entries(USERS))
    sqlite.exec(`INSERT INTO users(id, email, name, password_hash, role, signature) VALUES (${u.id}, '${name}@x', '${name}', 'x', '${u.role}', 'data:image/png;base64,${name}')`);
  sqlite.exec(`INSERT INTO clients(id, name, address, contact_name, accurate_customer_no) VALUES (7, 'PT Mestika', 'Jl. Satu', 'Bu Ani', 'C.00030')`);
  sqlite.exec(`INSERT INTO catalog_items(code, name, uom, cogs, list_price) VALUES ('B1', 'Spidol', 'Pcs', 2500, 3500), ('K1', 'Kertas', 'Pcs', 10000, 15000)`);
  sqlite.exec(`INSERT INTO accurate_items(entity, accurate_id, code, name, uom, unit_price, units, run_id) VALUES
    ('PT', 1, 'B1', 'Spidol', 'Pcs', 3500, '[{"uom":"Lusin","factor":12}]', 'r'), ('PT', 2, 'K1', 'Kertas', 'Pcs', 15000, '[]', 'r')`);
  sqlite.exec(`INSERT INTO accurate_receipt_lines(entity, receipt_id, line_id, receipt_no, trans_date, item_code, unit, quantity, unit_price) VALUES
    ('PT', 900, 1, 'RI.1', '2026-06-02', 'B1', 'Lusin', 1, 30000), ('PT', 901, 1, 'RI.2', '2026-06-02', 'K1', 'Pcs', 1, 10000)`);
  // B1: 2 Lusin for 48.000 = 2.000/Pcs against 2.500 (a real loss). K1: 9.009 against 10.000 = the 11% of PPN (a data slip).
  sqlite.exec(`INSERT INTO accurate_sales_lines(entity, invoice_id, line_id, invoice_no, trans_date, customer_no, customer_name, item_code,
                 unit, unit_ratio, quantity, sales_amount, inclusive_tax, tax_rate, sub_total, synced_at) VALUES
    ('PT', 1, 1, 'SI.A', '2026-06-05', 'C.00030', 'MESTIKA', 'B1', 'Lusin', 12, 2, 48000, 0, 11, 57009, 'x'),
    ('PT', 1, 2, 'SI.A', '2026-06-05', 'C.00030', 'MESTIKA', 'K1', 'Pcs', 1, 1, 9009, 0, 11, 57009, 'x')`);
  let as: Role = "manager";
  const app = new Hono<Env>();
  app.use(async (c, next) => {
    c.set("user", { id: USERS[as].id, email: `${as}@x`, name: as, role: USERS[as].role } as never);
    await next();
  });
  app.route("/api/price-letters", priceLettersRouter);
  const env = { DB: new D1DatabaseShim(sqlite) as unknown as D1Database, ACCURATE_CATALOG_ENTITY: "PT" } as unknown as Env["Bindings"];
  const req = async (who: Role, method: string, url: string, body?: unknown) => {
    as = who;
    const r = await app.request(`/api/price-letters${url}`, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }, env);
    return { status: r.status, json: (await r.json()) as Record<string, any> };
  };
  const create = (who: Role, price = 38150) =>
    req(who, "POST", "", { invoice_no: "SI.A", effective_date: "2026-12-01", lines: [{ code: "B1", new_price: price }] });
  return { sqlite, req, create };
}

describe("surat perubahan harga", () => {
  it("analisa SI: hanya rugi sungguhan, per Lusin seperti dibeli klien, usulan lolos margin minimum", async () => {
    const { req } = setup();
    const a = await req("manager", "GET", "/analysis?invoice=SI.A");
    expect(a.status).toBe(200);
    expect(a.json.rows).toHaveLength(2); // both lines are under cost ...
    expect(a.json.lines).toEqual([
      // ... but only B1 is a real loss. 30.000 x 1,08 / 0,85 = 38.117,6 -> 38.150.
      expect.objectContaining({ code: "B1", unit: "Lusin", oldPrice: 24000, cost: 30000, suggested: 38150, group: "none" }),
    ]);
    expect(a.json.client).toMatchObject({ id: 7, contact_name: "Bu Ani" });
    expect((await req("manager", "GET", "/analysis?invoice=SI.X")).status).toBe(404);
  });

  it("sales tidak bisa melihat atau membuat surat", async () => {
    const { req, create } = setup();
    expect((await req("rep", "GET", "/analysis?invoice=SI.A")).status).toBe(403);
    expect((await create("rep")).status).toBe(403);
  });

  it("harga dihitung ulang di server: yang masih rugi, barang non-rugi, dan surat kedua ditolak", async () => {
    const { req, create, sqlite } = setup();
    expect((await create("manager", 30000)).json.error).toContain("tetap rugi");
    const k1 = await req("manager", "POST", "", { invoice_no: "SI.A", effective_date: "2026-12-01", lines: [{ code: "K1", new_price: 20000 }] });
    expect(k1.status).toBe(400);
    const ok = await create("manager", 39000);
    expect(ok.status).toBe(201);
    expect(ok.json.number).toMatch(/^SIP\/SPH\/\d{4}\/001$/);
    expect(sqlite.prepare("SELECT old_price, cost, suggested, new_price, unit FROM price_letter_lines").all()).toEqual([
      { old_price: 24000, cost: 30000, suggested: 38150, new_price: 39000, unit: "Lusin" },
    ]);
    expect((await create("manager2")).status).toBe(409);
  });

  it("ACC: pembuat tidak bisa ACC sendiri, TTD hanya setelah ACC, keputusan kedua 409", async () => {
    const { req, create } = setup();
    const { id } = (await create("manager")).json;
    expect((await req("manager", "POST", `/${id}/decide`, { decision: "approved" })).status).toBe(403);
    expect((await req("manager2", "GET", `/${id}/signature`)).json.signature).toBe("");
    expect((await req("manager2", "POST", `/${id}/decide`, { decision: "approved" })).status).toBe(200);
    expect((await req("manager2", "GET", `/${id}/signature`)).json).toEqual({ name: "manager", signature: "data:image/png;base64,manager" });
    expect((await req("admin", "POST", `/${id}/decide`, { decision: "rejected" })).status).toBe(409);
    const one = await req("manager", "GET", `/${id}`);
    expect(one.json.letter).toMatchObject({ status: "approved", decided_by_name: "manager2", client_contact: "Bu Ani" });
    expect(one.json.lines).toHaveLength(1);
  });

  it("aturan 'admin saja' di Pengaturan berlaku juga untuk surat; pembuat tetap bisa menarik draftnya", async () => {
    const { req, create, sqlite } = setup();
    sqlite.exec(`INSERT INTO settings(key, value) VALUES ('policy', '{"minNetMargin":0.15,"minLineMargin":0,"maxBasketDiscount":0.3,"approvalValueThreshold":0,"blockApprover":"admin"}')`);
    const { id } = (await create("manager")).json;
    expect((await req("manager2", "POST", `/${id}/decide`, { decision: "approved" })).status).toBe(403);
    expect((await req("manager", "POST", `/${id}/decide`, { decision: "rejected", note: "salah hitung" })).status).toBe(200);
    // Rejected: a new letter for the same SI may be made, and an admin can ACC it.
    const again = await create("manager");
    expect(again.status).toBe(201);
    expect((await req("admin", "POST", `/${again.json.id}/decide`, { decision: "approved" })).status).toBe(200);
  });
});
