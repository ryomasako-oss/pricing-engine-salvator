import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { D1DatabaseShim } from "../../scripts/d1-sqlite-shim";
import { duplicateReportsRouter } from "./routes/duplicateReports";
import { catalogRouter } from "./routes/catalog";
import { searchItems } from "./catalogSearchIndex";
import type { Env } from "./env";

/* 2026-11-25: ACC Duplikat mengarsipkan barang yang kalah (disembunyikan, bukan dihapus). */

type Role = "gudang" | "rep" | "manager" | "admin";
const USERS: Record<Role, number> = { gudang: 1, rep: 2, manager: 3, admin: 4 };

function setup() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = path.resolve(import.meta.dirname, "../../migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(path.join(dir, f), "utf8"));
  for (const [role, id] of Object.entries(USERS))
    sqlite.exec(`INSERT INTO users(id, email, name, password_hash, role) VALUES (${id}, '${role}@x', '${role}', 'x', '${role}')`);
  sqlite.exec(`INSERT INTO catalog_items(id, code, name, uom) VALUES (1, 'R-1', 'RANTAI BESI SS304 3MM', 'Mtr'), (2, 'R-2', 'RANTAI BESI SS 304 3MM', 'Mtr'), (3, 'R-3', 'RANTAI BESI SS-304 3 MM', 'Mtr'), (4, 'P-1', 'Pulpen', 'Pcs')`);
  let role: Role = "gudang";
  const app = new Hono<Env>();
  app.use(async (c, next) => {
    c.set("user", { id: USERS[role], email: `${role}@x`, name: role, role } as never);
    await next();
  });
  app.route("/api/duplicate-reports", duplicateReportsRouter);
  app.route("/api/catalog", catalogRouter);
  const env = { DB: new D1DatabaseShim(sqlite) as unknown as D1Database } as unknown as Env["Bindings"];
  const req = async (as: Role, method: string, url: string, body?: unknown) => {
    role = as;
    const r = await app.request(url, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }, env);
    return { status: r.status, json: (await r.json()) as Record<string, any> };
  };
  const rows = (sql: string) => sqlite.prepare(sql).all();
  return { sqlite, env, req, rows };
}

/** Lapor 1,2,3 sebagai satu kelompok dan ACC dengan barang 1 yang dipakai. */
async function archiveTwo(s: ReturnType<typeof setup>) {
  await s.req("gudang", "POST", "/api/duplicate-reports", { item_ids: [1, 2, 3] });
  const id = (await s.req("admin", "GET", "/api/duplicate-reports")).json.items[0].id;
  return { id, decide: (as: Role, body: unknown) => s.req(as, "POST", `/api/duplicate-reports/${id}/decide`, body) };
}

const names = async (s: ReturnType<typeof setup>, q: string) =>
  (await s.req("admin", "GET", `/api/catalog?q=${encodeURIComponent(q)}`)).json.items.map((i: { code: string }) => i.code).sort();

describe("arsip barang", () => {
  it("ACC mengarsipkan barang lain di kelompok, barang yang dipakai tetap", async () => {
    const s = setup();
    const { decide } = await archiveTwo(s);
    expect((await decide("admin", { decision: "approved", keep_item_id: 1 })).status).toBe(200);
    expect(s.rows("SELECT id, archived_at IS NOT NULL AS arsip, archived_by, archived_note FROM catalog_items ORDER BY id")).toEqual([
      { id: 1, arsip: 0, archived_by: null, archived_note: "" },
      { id: 2, arsip: 1, archived_by: 4, archived_note: "Duplikat dari R-1" },
      { id: 3, arsip: 1, archived_by: 4, archived_note: "Duplikat dari R-1" },
      { id: 4, arsip: 0, archived_by: null, archived_note: "" },
    ]);
    expect(s.rows("SELECT action FROM audit_log WHERE entity = 'duplicate_report'").length).toBeGreaterThan(0);
  });

  it("Tolak tidak mengarsipkan apa pun", async () => {
    const s = setup();
    const { decide } = await archiveTwo(s);
    expect((await decide("admin", { decision: "rejected" })).status).toBe(200);
    expect(s.rows("SELECT id FROM catalog_items WHERE archived_at IS NOT NULL")).toEqual([]);
  });

  it("barang arsip hilang dari daftar Katalog dan pencarian, tampil di Arsip; sinkron tetap boleh memperbaruinya", async () => {
    const s = setup();
    const { decide } = await archiveTwo(s);
    expect(await names(s, "rantai")).toEqual(["R-1", "R-2", "R-3"]); // indeks pencarian terisi (di-cache) sebelum ACC
    await decide("admin", { decision: "approved", keep_item_id: 1 });
    expect(await names(s, "rantai")).toEqual(["R-1"]);
    const list = (await s.req("admin", "GET", "/api/catalog?limit=100")).json;
    expect(list.items.map((i: { code: string }) => i.code).sort()).toEqual(["P-1", "R-1"]);
    expect(list.total).toBe(2);
    const arsip = (await s.req("gudang", "GET", "/api/catalog/archived")).json;
    expect(arsip.total).toBe(2);
    expect(arsip.items[0]).toMatchObject({ archived_note: "Duplikat dari R-1", archived_by_name: "admin", accurate_status: "belum" });
    expect(arsip.items[0].cogs).toBeUndefined();
    expect((await s.req("gudang", "GET", "/api/catalog/archived?q=SS-304")).json.items.map((i: { code: string }) => i.code)).toEqual(["R-3"]);
    // Pencarian bersama (picker, chat) memakai indeks yang sama.
    expect((await searchItems(s.env.DB, "rantai")).items.map((i) => i.code)).toEqual(["R-1"]);
    // Sinkron Accurate memperbarui lewat UPDATE ... WHERE code: baris arsip tetap ada dan tidak disaring.
    s.sqlite.exec("UPDATE catalog_items SET stock = 9 WHERE code = 'R-2'");
    expect(s.rows("SELECT stock FROM catalog_items WHERE code = 'R-2'")).toEqual([{ stock: 9 }]);
  });

  it("Pulihkan mengembalikan barang ke Katalog; hanya Admin", async () => {
    const s = setup();
    const { decide } = await archiveTwo(s);
    await decide("admin", { decision: "approved", keep_item_id: 1 });
    expect((await s.req("gudang", "POST", "/api/catalog/2/restore")).status).toBe(403);
    expect((await s.req("manager", "POST", "/api/catalog/2/restore")).status).toBe(403);
    expect((await s.req("admin", "POST", "/api/catalog/4/restore")).status).toBe(404);
    expect((await s.req("admin", "POST", "/api/catalog/2/restore")).status).toBe(200);
    expect(s.rows("SELECT archived_at, archived_by, archived_note, accurate_off_at FROM catalog_items WHERE id = 2")).toEqual([
      { archived_at: null, archived_by: null, archived_note: "", accurate_off_at: null },
    ]);
    expect(await names(s, "rantai")).toEqual(["R-1", "R-2"]);
    expect((await s.req("admin", "GET", "/api/catalog/archived")).json.total).toBe(1);
  });

  it("status Nonaktifkan di Accurate: belum, lalu sudah lewat suspended=1, hilang dari Accurate, atau tanda manual", async () => {
    const s = setup();
    const { id, decide } = await archiveTwo(s);
    await decide("admin", { decision: "approved", keep_item_id: 1 });
    const status = async () =>
      Object.fromEntries((await s.req("admin", "GET", "/api/catalog/archived")).json.items.map((i: any) => [i.code, i.accurate_status]));
    // Sinkron belum pernah jalan: belum tahu = belum.
    expect(await status()).toEqual({ "R-2": "belum", "R-3": "belum" });
    const acc = (code: string, suspended: number) =>
      s.sqlite.exec(`INSERT INTO accurate_items(entity, accurate_id, code, run_id, suspended) VALUES ('PT', ${Number(code.slice(2)) * 10 + 1}, '${code}', 'r', ${suspended})`);
    acc("R-1", 0);
    acc("R-2", 0);
    acc("R-3", 0);
    expect(await status()).toEqual({ "R-2": "belum", "R-3": "belum" });
    s.sqlite.exec("UPDATE accurate_items SET suspended = 1 WHERE code = 'R-2'");
    expect(await status()).toEqual({ "R-2": "sudah", "R-3": "belum" });
    // Entity lain tidak dihitung.
    s.sqlite.exec("UPDATE accurate_items SET entity = 'CV' WHERE code = 'R-3'");
    expect(await status()).toEqual({ "R-2": "sudah", "R-3": "sudah" }); // PT sudah terisi, R-3 hilang dari PT
    s.sqlite.exec("UPDATE accurate_items SET entity = 'PT' WHERE code = 'R-3'");
    expect(await status()).toEqual({ "R-2": "sudah", "R-3": "belum" });
    // Tanda manual.
    expect((await s.req("gudang", "POST", "/api/catalog/3/accurate-off")).status).toBe(403);
    expect((await s.req("manager", "POST", "/api/catalog/3/accurate-off")).status).toBe(403);
    expect((await s.req("admin", "POST", "/api/catalog/4/accurate-off")).status).toBe(404);
    expect((await s.req("admin", "POST", "/api/catalog/3/accurate-off")).status).toBe(200);
    expect(await status()).toEqual({ "R-2": "sudah", "R-3": "sudah" });
    expect(s.rows("SELECT accurate_off_by FROM catalog_items WHERE id = 3")).toEqual([{ accurate_off_by: 4 }]);
    // Kartu laporan Duplikat yang sudah di-ACC membawa status yang sama.
    const hist = (await s.req("gudang", "GET", "/api/duplicate-reports?status=decided")).json;
    expect(hist.archived.map((a: any) => [a.code, a.accurate_status]).sort()).toEqual([["R-2", "sudah"], ["R-3", "sudah"]]);
    void id;
  });

  it("izin ACC tetap: Admin Gudang tidak bisa meng-ACC, tidak ada yang diarsipkan", async () => {
    const s = setup();
    const { decide } = await archiveTwo(s);
    expect((await decide("gudang", { decision: "approved", keep_item_id: 1 })).status).toBe(403);
    expect(s.rows("SELECT id FROM catalog_items WHERE archived_at IS NOT NULL")).toEqual([]);
  });
});
