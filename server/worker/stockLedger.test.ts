import { describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { D1DatabaseShim } from "../../scripts/d1-sqlite-shim";
import { catalogRouter } from "./routes/catalog";
import { accurateRouter } from "./routes/accurate";
import { stockRouter } from "./routes/stock";
import { syncTick } from "./accurate/sync";
import { forgetCatalogIndex } from "./catalogSearchIndex";
import type { Env } from "./env";

/* 2026-11-20: koreksi stok wajib di-ACC admin; sinkron Accurate tidak lagi menimpa stok katalog; Tarik,
   Cocokkan, riwayat stok, dan penanda "belum terkirim". */

const USERS = { gudang: 1, admin: 2, manager: 3, rep: 4 } as const;
type Who = keyof typeof USERS;

function setup() {
  forgetCatalogIndex();
  const sqlite = new DatabaseSync(":memory:");
  const dir = path.resolve(import.meta.dirname, "../../migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(path.join(dir, f), "utf8"));
  for (const [role, id] of Object.entries(USERS)) {
    sqlite.exec(`INSERT INTO users(id, email, name, role, password_hash) VALUES (${id}, '${role}@x', '${role}', '${role}', 'x')`);
  }
  sqlite.exec(`INSERT INTO catalog_items(id, code, name, uom, cogs, list_price, stock) VALUES
    (1, 'P-1', 'Pulpen', 'Pcs', 1000, 2000, 10), (2, 'K-1', 'Kertas', 'Rim', 500, 900, 5), (3, 'L-1', 'Lem', 'Pcs', 300, 600, 7)`);
  sqlite.exec(`INSERT INTO accurate_items(entity, accurate_id, code, name, uom, unit_price, units, category, suspended, run_id) VALUES
    ('PT', 1, 'P-1', 'Pulpen', 'Pcs', 2000, '[]', '', 0, 'r1'),
    ('PT', 2, 'K-1', 'Kertas', 'Rim', 900, '[]', '', 0, 'r1'),
    ('PT', 3, 'L-1', 'Lem', 'Pcs', 600, '[]', '', 0, 'r1')`);
  sqlite.exec(`INSERT INTO accurate_stock(entity, warehouse_id, item_code, quantity, run_id) VALUES
    ('PT', 1, 'P-1', 30, 'r1'), ('PT', 2, 'P-1', 12, 'r1'), ('PT', 1, 'K-1', 5, 'r1'), ('PT', 1, 'L-1', 70, 'r1')`);
  sqlite.exec(`INSERT INTO accurate_sync_state(entity, phase, last_success_at) VALUES ('PT', 'idle', '${new Date().toISOString()}')`);
  let who: Who = "gudang";
  const app = new Hono<Env>();
  app.use(async (c, next) => {
    c.set("user", { id: USERS[who], email: `${who}@x`, name: who, role: who } as never);
    await next();
  });
  app.route("/api/catalog", catalogRouter);
  app.route("/api/stock", stockRouter);
  app.route("/api/accurate", accurateRouter);
  const db = new D1DatabaseShim(sqlite) as unknown as D1Database;
  const env = { DB: db, ACCURATE_TOKEN_PT: "aat.t", ACCURATE_SIGNATURE_SECRET: "s" } as unknown as Env["Bindings"];
  const req = (as: Who, p: string, method = "GET", body?: unknown) => {
    who = as;
    return app.request(p, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }, env);
  };
  const q = (sql: string, ...args: (string | number)[]) => sqlite.prepare(sql).all(...args) as Record<string, unknown>[];
  const stockOf = (code: string) => q("SELECT stock FROM catalog_items WHERE code = ?", code)[0].stock as number;
  const draftId = async () => ((await (await req("admin", "/api/catalog/drafts")).json()) as { drafts: { id: number }[] }).drafts[0].id;
  return { req, q, stockOf, draftId, db, env, sqlite };
}

describe("sinkron Accurate tidak lagi menimpa stok katalog", () => {
  it("a completed run's cross-check tick leaves the catalog stock alone", async () => {
    const { q, env, sqlite, stockOf } = setup();
    sqlite.exec("UPDATE accurate_sync_state SET reconciled_at = NULL");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await syncTick(env, { deadlineMs: 5_000 });
    spy.mockRestore();
    expect(q("SELECT reconciled_at FROM accurate_sync_state")[0].reconciled_at).not.toBeNull(); // the step did run
    expect(stockOf("P-1")).toBe(10);
    expect(q("SELECT * FROM stock_history")).toHaveLength(0);
  });
});

describe("draf stok", () => {
  it("is a draft until ACC; ACC sets the stock, writes history and marks the item unsent", async () => {
    const { req, q, stockOf, draftId } = setup();
    expect((await req("gudang", "/api/catalog/1/stock", "PUT", { stock: 25 })).status).toBe(200);
    expect(stockOf("P-1")).toBe(10);
    expect(q("SELECT * FROM stock_history")).toHaveLength(0);
    const id = await draftId();
    expect((await req("admin", `/api/catalog/drafts/${id}/review`, "POST", { approve: true })).status).toBe(200);
    expect(stockOf("P-1")).toBe(25);
    expect(q("SELECT code, uom, qty_before, qty_after, source, draft_id, filled_by, approved_by FROM stock_history")).toEqual([
      { code: "P-1", uom: "Pcs", qty_before: 10, qty_after: 25, source: "draft_approved", draft_id: id, filled_by: USERS.gudang, approved_by: USERS.admin },
    ]);
    expect(q("SELECT code FROM stock_unsent")).toEqual([{ code: "P-1" }]);
    expect(q("SELECT actor_id FROM audit_log WHERE action = 'stock_set'")).toEqual([{ actor_id: USERS.admin }]);
  });

  it("an admin's own stock change is also a draft; a rep may not draft stock; same number is refused", async () => {
    const { req, stockOf, q } = setup();
    expect((await req("admin", "/api/catalog/1/stock", "PUT", { stock: 3 })).status).toBe(200);
    expect(stockOf("P-1")).toBe(10);
    expect(q("SELECT kind FROM catalog_drafts")).toEqual([{ kind: "stock" }]);
    expect((await req("rep", "/api/catalog/1/stock", "PUT", { stock: 3 })).status).toBe(403);
    expect((await req("gudang", "/api/catalog/1/stock", "PUT", { stock: 10 })).status).toBe(400);
    expect((await req("gudang", "/api/catalog/1/stock", "PUT", { stock: -1 })).status).toBe(400);
  });

  it("a rejection keeps the stock and writes who proposed, who refused and why", async () => {
    const { req, q, stockOf, draftId } = setup();
    await req("gudang", "/api/catalog/1/stock", "PUT", { stock: 99 });
    const id = await draftId();
    expect((await req("admin", `/api/catalog/drafts/${id}/review`, "POST", { approve: false, note: "Hitung ulang" })).status).toBe(200);
    expect(stockOf("P-1")).toBe(10);
    expect(q("SELECT qty_before, qty_after, source, filled_by, approved_by, note FROM stock_history")).toEqual([
      { qty_before: 10, qty_after: 99, source: "draft_rejected", filled_by: USERS.gudang, approved_by: USERS.admin, note: "Hitung ulang" },
    ]);
    expect(q("SELECT * FROM stock_unsent")).toHaveLength(0);
  });

  it("the migration kept the older draft kinds working", async () => {
    const { req, q } = setup();
    await req("gudang", "/api/catalog/1/barcode", "PUT", { barcode: "123" });
    expect(q("SELECT kind FROM catalog_drafts")).toEqual([{ kind: "barcode" }]);
  });
});

describe("Tarik", () => {
  it("copies Accurate's total, skips an item whose ACCed change is unsent, writes history for the rest", async () => {
    const { req, q, stockOf, draftId } = setup();
    await req("gudang", "/api/catalog/3/stock", "PUT", { stock: 8 });
    await req("admin", `/api/catalog/drafts/${await draftId()}/review`, "POST", { approve: true });
    const res = await req("manager", "/api/stock/pull", "POST", {});
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ done: true, changed: 1, skipped: 1 });
    expect(stockOf("P-1")).toBe(42); // 30 + 12 over both warehouses
    expect(stockOf("K-1")).toBe(5); // already equal: no history
    expect(stockOf("L-1")).toBe(8); // ACCed 8 survives Accurate's 70
    expect(q("SELECT code, qty_before, qty_after, source, filled_by FROM stock_history WHERE source = 'tarik'")).toEqual([
      { code: "P-1", qty_before: 10, qty_after: 42, source: "tarik", filled_by: USERS.manager },
    ]);
  });

  it("is open to the Admin Gudang and manager, not to a rep", async () => {
    const { req } = setup();
    expect((await req("gudang", "/api/stock/pull", "POST", {})).status).toBe(200);
    expect((await req("rep", "/api/stock/pull", "POST", {})).status).toBe(403);
  });
});

describe("Terapkan ke katalog", () => {
  it("also skips an unsent item and writes history for the stock it changes", async () => {
    const { req, q, stockOf, draftId } = setup();
    await req("gudang", "/api/catalog/3/stock", "PUT", { stock: 8 });
    await req("admin", `/api/catalog/drafts/${await draftId()}/review`, "POST", { approve: true });
    const res = await req("manager", "/api/accurate/apply", "POST", { entity: "PT" });
    expect(res.status).toBe(200);
    expect(stockOf("P-1")).toBe(42);
    expect(stockOf("L-1")).toBe(8);
    expect(q("SELECT code, qty_before, qty_after, source, filled_by FROM stock_history WHERE source = 'apply'")).toEqual([
      { code: "P-1", qty_before: 10, qty_after: 42, source: "apply", filled_by: USERS.manager },
    ]);
  });
});

describe("Cocokkan", () => {
  it("lists differences with the unsent flag, and no cost or price field", async () => {
    const { req, draftId } = setup();
    await req("gudang", "/api/catalog/3/stock", "PUT", { stock: 8 });
    await req("admin", `/api/catalog/drafts/${await draftId()}/review`, "POST", { approve: true });
    const res = await req("gudang", "/api/stock/compare");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Record<string, unknown>[] };
    expect(body.items).toEqual([
      { code: "L-1", name: "Lem", uom: "Pcs", pe: 8, accurate: 70, diff: -62, unsent: true },
      { code: "P-1", name: "Pulpen", uom: "Pcs", pe: 10, accurate: 42, diff: -32, unsent: false },
    ]);
    expect(JSON.stringify(body)).not.toMatch(/cogs|list_price/);
    expect((await req("rep", "/api/stock/compare")).status).toBe(403);
  });
});

describe("Kirim dan riwayat", () => {
  it("shows the switch off and the unsent count; history is per item", async () => {
    const { req, draftId } = setup();
    await req("gudang", "/api/catalog/1/stock", "PUT", { stock: 25 });
    await req("admin", `/api/catalog/drafts/${await draftId()}/review`, "POST", { approve: true });
    expect(await (await req("manager", "/api/stock/status")).json()).toEqual({ pushEnabled: false, unsent: 1 });
    const h = (await (await req("gudang", "/api/stock/history?code=P-1")).json()) as { history: Record<string, unknown>[] };
    expect(h.history[0]).toMatchObject({ code: "P-1", before: 10, after: 25, source: "draft_approved", filled_by_name: "gudang", approved_by_name: "admin" });
    expect(((await (await req("gudang", "/api/stock/history?code=K-1")).json()) as { history: unknown[] }).history).toHaveLength(0);
  });
});

describe("impor spreadsheet", () => {
  it("never writes stock: changed numbers become stock drafts, a new item starts at 0 with a draft", async () => {
    const { req, q, stockOf } = setup();
    const r = await req("manager", "/api/catalog/import", "POST", {
      rows: [
        { code: "P-1", name: "Pulpen", uom: "Pcs", stock: 99 },
        { code: "K-1", name: "Kertas", uom: "Rim", stock: 5 },
        { code: "B-1", name: "Baru", uom: "Pcs", stock: 4 },
      ],
    });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { stockDrafts: number }).stockDrafts).toBe(2);
    expect(stockOf("P-1")).toBe(10);
    expect(stockOf("B-1")).toBe(0);
    const drafts = q("SELECT code, payload, before, created_by FROM catalog_drafts WHERE kind = 'stock' AND status = 'pending' ORDER BY code");
    expect(drafts.map((d) => [d.code, JSON.parse(d.payload as string).stock, JSON.parse(d.before as string).stock, d.created_by])).toEqual([
      ["B-1", 4, 0, USERS.manager],
      ["P-1", 99, 10, USERS.manager],
    ]);
  });
});
