import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { D1DatabaseShim } from "../../scripts/d1-sqlite-shim";
import { duplicateReportsRouter } from "./routes/duplicateReports";
import type { Env } from "./env";

/* 2026-11-25: laporan duplikat dari Admin Gudang (tab Duplikat), diputuskan Admin. */

type Role = "gudang" | "rep" | "manager" | "admin";
const USERS: Record<Role, number> = { gudang: 1, rep: 2, manager: 3, admin: 4 };

function setup() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = path.resolve(import.meta.dirname, "../../migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(path.join(dir, f), "utf8"));
  for (const [role, id] of Object.entries(USERS))
    sqlite.exec(`INSERT INTO users(id, email, name, password_hash, role) VALUES (${id}, '${role}@x', '${role}', 'x', '${role}')`);
  sqlite.exec(`INSERT INTO catalog_items(id, code, name, uom) VALUES (1, 'R-1', 'RANTAI BESI SS304 3MM', 'Mtr'), (2, 'R-2', 'RANTAI BESI SS 304 3MM', 'Mtr'), (3, 'P-1', 'Pulpen', 'Pcs')`);
  let role: Role = "gudang";
  const app = new Hono<Env>();
  app.use(async (c, next) => {
    c.set("user", { id: USERS[role], email: `${role}@x`, name: role, role } as never);
    await next();
  });
  app.route("/api/duplicate-reports", duplicateReportsRouter);
  const env = { DB: new D1DatabaseShim(sqlite) as unknown as D1Database } as unknown as Env["Bindings"];
  const req = async (as: Role, method: string, url: string, body?: unknown) => {
    role = as;
    const r = await app.request(`/api/duplicate-reports${url}`, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }, env);
    return { status: r.status, json: (await r.json()) as Record<string, any> };
  };
  return { sqlite, req };
}

describe("laporan duplikat", () => {
  it("Admin Gudang melapor dan melihat laporannya sendiri; pasangan terbalik tidak jadi laporan kedua", async () => {
    const { req } = setup();
    const r = await req("gudang", "POST", "", { item_a_id: 2, item_b_id: 1, note: "beda spasi" });
    expect(r.status).toBe(201);
    expect(r.json.item).toMatchObject({ item_a_id: 1, item_b_id: 2, status: "open", reported_by_name: "gudang" });
    expect((await req("gudang", "POST", "", { item_a_id: 1, item_b_id: 2 })).status).toBe(409);
    const list = await req("gudang", "GET", "");
    expect(list.json.items.map((i: { item_a_name: string }) => i.item_a_name)).toEqual(["RANTAI BESI SS304 3MM"]);
    expect((await req("gudang", "GET", "/count")).json.open).toBe(1);
  });

  it("Sales tidak bisa melapor; Admin Gudang dan Manajer tidak bisa memutuskan; Admin bisa", async () => {
    const { req } = setup();
    expect((await req("rep", "POST", "", { item_a_id: 1, item_b_id: 2 })).status).toBe(403);
    const { json } = await req("gudang", "POST", "", { item_a_id: 1, item_b_id: 2 });
    const id = json.item.id;
    expect((await req("gudang", "POST", `/${id}/decide`, { decision: "approved", keep_item_id: 1 })).status).toBe(403);
    expect((await req("manager", "POST", `/${id}/decide`, { decision: "approved", keep_item_id: 1 })).status).toBe(403);
    expect((await req("admin", "POST", `/${id}/decide`, { decision: "approved", keep_item_id: 3 })).status).toBe(400);
    expect((await req("admin", "POST", `/${id}/decide`, { decision: "approved", keep_item_id: 1 })).status).toBe(200);
    expect((await req("admin", "POST", `/${id}/decide`, { decision: "rejected" })).status).toBe(409);
    const history = await req("gudang", "GET", "?status=decided");
    expect(history.json.items[0]).toMatchObject({ status: "approved", kept_item_id: 1, decided_by_name: "admin" });
  });

  it("barang yang dilaporkan tetap bisa dihapus dari katalog, dan laporannya tetap terbaca", async () => {
    const { sqlite, req } = setup();
    await req("gudang", "POST", "", { item_a_id: 1, item_b_id: 2 });
    sqlite.exec("DELETE FROM catalog_items WHERE id = 2");
    const list = await req("admin", "GET", "");
    expect(list.json.items[0]).toMatchObject({ item_b_id: 2, item_b_code: "R-2", item_b_name: "RANTAI BESI SS 304 3MM" });
  });
});
