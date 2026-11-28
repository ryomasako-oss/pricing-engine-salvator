import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { D1DatabaseShim } from "../../scripts/d1-sqlite-shim";
import { accurateRouter } from "./routes/accurate";
import { fixTasksRouter } from "./routes/fixTasks";
import type { Env } from "./env";

/* 2026-11-28: "Jelaskan" di Jual < Beli — penjelasan tim jadi tugas "Jual di bawah beli" di Perlu diperbaiki. */

type Role = "rep" | "manager" | "admin";
const USERS: Record<Role, number> = { rep: 1, manager: 2, admin: 3 };

function setup() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = path.resolve(import.meta.dirname, "../../migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(path.join(dir, f), "utf8"));
  for (const [role, id] of Object.entries(USERS)) sqlite.exec(`INSERT INTO users(id, email, name, password_hash, role) VALUES (${id}, '${role}@x', '${role}', 'x', '${role}')`);
  sqlite.exec(`INSERT INTO catalog_items(code, name, uom, cogs, list_price) VALUES ('B1', 'Spidol', 'Pcs', 2500, 3500), ('K1', 'Kertas', 'Pcs', 1000, 1500)`);
  sqlite.exec(`INSERT INTO accurate_items(entity, accurate_id, code, name, uom, unit_price, units, run_id) VALUES
    ('PT', 1, 'B1', 'Spidol', 'Pcs', 3500, '[{"uom":"Lusin","factor":12}]', 'r'), ('PT', 2, 'K1', 'Kertas', 'Pcs', 1500, '[]', 'r')`);
  sqlite.exec(`INSERT INTO accurate_receipt_lines(entity, receipt_id, line_id, receipt_no, trans_date, item_code, unit, quantity, unit_price) VALUES
    ('PT', 900, 1, 'RI.1', '2026-06-02', 'B1', 'Lusin', 1, 30000), ('PT', 901, 1, 'RI.2', '2026-06-02', 'K1', 'Pcs', 1, 1000)`);
  // B1: 2 Lusin for 48.000 = 2.000/Pcs under 2.500. K1: 1.200 over 1.000, not under cost.
  sqlite.exec(`INSERT INTO accurate_sales_lines(entity, invoice_id, line_id, invoice_no, trans_date, customer_no, customer_name, item_code,
                 unit, unit_ratio, quantity, sales_amount, inclusive_tax, tax_rate, sub_total, synced_at) VALUES
    ('PT', 1, 1, 'SI.A', '2026-06-05', 'C.1', 'MESTIKA', 'B1', 'Lusin', 12, 2, 48000, 0, 11, 49200, 'x'),
    ('PT', 1, 2, 'SI.A', '2026-06-05', 'C.1', 'MESTIKA', 'K1', 'Pcs', 1, 1, 1200, 0, 11, 49200, 'x')`);
  let as: Role = "manager";
  const app = new Hono<Env>();
  app.use(async (c, next) => {
    c.set("user", { id: USERS[as], email: `${as}@x`, name: as, role: as } as never);
    await next();
  });
  app.route("/api/accurate", accurateRouter);
  app.route("/api/fix-tasks", fixTasksRouter);
  const env = { DB: new D1DatabaseShim(sqlite) as unknown as D1Database, ACCURATE_CATALOG_ENTITY: "PT" } as unknown as Env["Bindings"];
  const req = async (who: Role, method: string, url: string, body?: unknown) => {
    as = who;
    const r = await app.request(url, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }, env);
    return { status: r.status, json: (await r.json()) as Record<string, any> };
  };
  const explain = (who: Role, code = "B1", explanation = "Harga lama ke klien belum dinaikkan sejak PI Juni.") =>
    req(who, "POST", "/api/accurate/below-cost/explain", { invoice_no: "SI.A", code, explanation });
  const report = async () => (await req("manager", "GET", "/api/accurate/below-cost?from=2026-06-01&to=2026-06-30")).json.below;
  return { req, explain, report };
}

describe("Jelaskan di Jual < Beli", () => {
  it("penjelasan jadi tugas terbuka dengan fakta barisnya, dan terlihat di laporan dan Perlu diperbaiki", async () => {
    const { req, explain, report } = setup();
    expect((await report())[0].task).toBeNull();
    expect((await explain("manager")).status).toBe(201);
    const [row] = await report();
    expect(row.task).toMatchObject({ status: "open", detail: "Harga lama ke klien belum dinaikkan sejak PI Juni.", created_by_name: "manager" });
    const tasks = (await req("manager", "GET", "/api/fix-tasks")).json.tasks;
    expect(tasks).toEqual([
      expect.objectContaining({
        kind: "below_cost", line_id: "SI.A", code: "B1", item_name: "Spidol", qty: 2, uom: "Lusin",
        context: "SI.A · MESTIKA · 2026-06-05 · jual Rp 2.000/Pcs, beli Rp 2.500 (RI.1) · rugi Rp 12.000",
      }),
    ]);
  });

  it("satu tugas terbuka per baris; setelah selesai boleh dijelaskan lagi", async () => {
    const { req, explain, report } = setup();
    const { id } = (await explain("manager")).json;
    expect((await explain("admin")).status).toBe(409);
    expect((await req("manager", "POST", `/api/fix-tasks/${id}/resolve`, { note: "Harga klien dinaikkan per Juli." })).status).toBe(200);
    expect((await report())[0].task).toMatchObject({ status: "done", resolution: "Harga klien dinaikkan per Juli.", resolved_by_name: "manager" });
    expect((await explain("admin", "B1", "Terjadi lagi di nota susulan.")).status).toBe(201);
  });

  it("sales tidak bisa; baris yang tidak di bawah beli dan penjelasan kosong ditolak; sales tidak melihat tugasnya", async () => {
    const { req, explain } = setup();
    expect((await explain("rep")).status).toBe(403);
    expect((await explain("manager", "K1")).status).toBe(404);
    expect((await explain("manager", "B1", "  ")).status).toBe(400);
    await explain("manager");
    expect((await req("rep", "GET", "/api/fix-tasks")).json.tasks).toEqual([]);
  });
});
