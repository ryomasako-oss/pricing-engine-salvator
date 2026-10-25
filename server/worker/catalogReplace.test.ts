import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { D1DatabaseShim } from "../../scripts/d1-sqlite-shim";
import { catalogRouter } from "./routes/catalog";
import { accurateRouter } from "./routes/accurate";
import { addNewItems } from "./accurate/newItems";
import type { Env } from "./env";

/* Audit P1-3 + P1-4 (23 Okt): "ganti semua" needed only import_catalog while
   DELETE /catalog needs delete_catalog, emptied the catalog before inserting,
   dropped the "COGS = pembelian terakhir" rule, and the next sync refilled
   every item the file left out with COGS 0. */

function freshDb() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = path.resolve(import.meta.dirname, "../../migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(path.join(dir, f), "utf8"));
  sqlite.exec(`INSERT INTO users(id, email, name, password_hash, role) VALUES (1, 'm@x', 'M', 'x', 'manager'), (2, 'a@x', 'A', 'x', 'admin')`);
  sqlite.exec(`INSERT INTO catalog_items(code, name, uom, cogs, list_price, stock, category) VALUES
    ('KEEP', 'Dibeli', 'Pcs', 2083, 3000, 5, 'ATK'),
    ('PLAIN', 'Biasa', 'Box', 700, 900, 2, 'ATK'),
    ('GONE', 'Tidak di file', 'Pcs', 100, 200, 1, '')`);
  sqlite.exec(`INSERT INTO catalog_item_uoms(code, uom, factor) VALUES ('PLAIN', 'Lusin', 12), ('GONE', 'Box', 10)`);
  // KEEP has a priced Accurate receipt: its COGS comes from "Terapkan COGS", not from a spreadsheet.
  sqlite.exec(`INSERT INTO accurate_receipt_lines(entity, receipt_id, line_id, trans_date, item_code, quantity, unit_price)
    VALUES ('PT', 309, 1, '2026-10-16', 'KEEP', 12, 2083)`);
  // Accurate has an item the catalog lacks, so addNewItems has something to add.
  sqlite.exec(`INSERT INTO accurate_items(entity, accurate_id, code, name, uom, unit_price, units, category, suspended, run_id)
    VALUES ('PT', 1, 'NEW1', 'Baru di Accurate', 'Pcs', 500, '[]', '', 0, 'r1')`);
  sqlite.exec(`INSERT OR REPLACE INTO accurate_sync_state(entity, phase, last_success_at) VALUES ('PT', 'idle', '${new Date().toISOString()}')`);
  return { sqlite, db: new D1DatabaseShim(sqlite) as unknown as D1Database };
}

function app(db: D1Database, role: "manager" | "admin") {
  const a = new Hono<Env>();
  a.use(async (c, next) => {
    c.set("user", { id: role === "admin" ? 2 : 1, email: "x@x", name: "X", role } as never);
    await next();
  });
  a.route("/api/catalog", catalogRouter);
  a.route("/api/accurate", accurateRouter);
  const env = { DB: db } as unknown as Env["Bindings"];
  return async (method: string, p: string, body?: unknown) => {
    const r = await a.request(p, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json" } }, env);
    return { status: r.status, json: (await r.json()) as Record<string, unknown> };
  };
}

const catalog = (sqlite: DatabaseSync) =>
  sqlite.prepare("SELECT code, name, uom, cogs, list_price, stock, category FROM catalog_items ORDER BY code").all();

const FILE = [
  { code: "KEEP", name: "Dibeli", cogs: 1800, list_price: 3100 },
  { code: "PLAIN", name: "Biasa baru", cogs: 0, list_price: 0 },
  { code: "FRESH", name: "Dari file", uom: "Rim", cogs: 50, list_price: 80 },
];

describe("impor katalog ganti semua", () => {
  it("is refused for a manager, before anything is deleted", async () => {
    const { sqlite, db } = freshDb();
    const before = catalog(sqlite);
    const r = await app(db, "manager")("POST", "/api/catalog/import", { rows: FILE, mode: "replace" });
    expect(r.status).toBe(403);
    expect(catalog(sqlite)).toEqual(before);
  });

  it("for an admin: the file wins, items not in it go, and a purchased item keeps its receipt COGS", async () => {
    const { sqlite, db } = freshDb();
    const r = await app(db, "admin")("POST", "/api/catalog/import", { rows: FILE, mode: "replace" });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ inserted: 1, updated: 2, removed: 1, total: 3 });
    expect(catalog(sqlite)).toEqual([
      { code: "FRESH", name: "Dari file", uom: "Rim", cogs: 50, list_price: 80, stock: 0, category: "" },
      { code: "KEEP", name: "Dibeli", uom: "Pcs", cogs: 2083, list_price: 3100, stock: 0, category: "" },
      // Replace writes 0 and blank as such (only a blank unit keeps the current one, so its ratios stay valid).
      { code: "PLAIN", name: "Biasa baru", uom: "Box", cogs: 0, list_price: 0, stock: 0, category: "" },
    ]);
    expect(sqlite.prepare("SELECT code, uom, factor FROM catalog_item_uoms").all()).toEqual([{ code: "PLAIN", uom: "Lusin", factor: 12 }]);
  });

  it("merge still never overwrites with 0 or blank", async () => {
    const { sqlite, db } = freshDb();
    await app(db, "manager")("POST", "/api/catalog/import", { rows: FILE, mode: "merge" });
    expect(catalog(sqlite).find((i) => (i as { code: string }).code === "PLAIN")).toEqual(
      { code: "PLAIN", name: "Biasa baru", uom: "Box", cogs: 700, list_price: 900, stock: 2, category: "ATK" },
    );
  });
});

describe("barang baru otomatis berhenti setelah katalog dikosongkan", () => {
  for (const [label, empty] of [
    ["clear", (call: ReturnType<typeof app>) => call("DELETE", "/api/catalog")],
    ["replace", (call: ReturnType<typeof app>) => call("POST", "/api/catalog/import", { rows: FILE, mode: "replace" })],
  ] as const) {
    it(`after ${label}, a completed run adds nothing until "Terapkan" is answered OK`, async () => {
      const { db } = freshDb();
      const call = app(db, "admin");
      expect((await empty(call)).status).toBe(200);
      expect(await addNewItems(db, "PT")).toEqual({ added: 0, codes: [] });

      // "Terapkan" without new items doesn't lift the pause.
      expect((await call("POST", "/api/accurate/apply", { entity: "PT" })).status).toBe(200);
      expect(await addNewItems(db, "PT")).toEqual({ added: 0, codes: [] });

      // OK to new items adds them itself and lifts it, so later Accurate items arrive again.
      expect((await call("POST", "/api/accurate/apply", { entity: "PT", insertNew: true })).status).toBe(200);
      await db.prepare(`INSERT INTO accurate_items(entity, accurate_id, code, name, uom, unit_price, units, category, suspended, run_id)
        VALUES ('PT', 2, 'NEW2', 'Lebih baru', 'Pcs', 0, '[]', '', 0, 'r2')`).run();
      expect(await addNewItems(db, "PT")).toEqual({ added: 1, codes: ["NEW2"] });
    });
  }
});
