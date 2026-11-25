import { afterEach, describe, expect, it, vi } from "vitest";
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

/* Stok (2026-11-25, menggantikan model 2026-11-20): stok katalog ikut Accurate otomatis tiap sinkron. Cycle count
   gudang per gudang menjadi draf; ACC menyimpannya sebagai stok pembanding (stock_counts) beserta stok Accurate
   gudang itu saat dihitung, tanpa mengubah stok katalog. "Belum masuk Accurate" selesai sendiri saat penyesuaian
   dengan jumlah yang sama muncul di riwayat mutasi, atau ditandai admin. */

const USERS = { gudang: 1, admin: 2, manager: 3, rep: 4 } as const;
type Who = keyof typeof USERS;
const MIGRATIONS = path.resolve(import.meta.dirname, "../../migrations");
const migrationFiles = () => readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();

afterEach(() => vi.unstubAllGlobals());

function setup() {
  forgetCatalogIndex();
  const sqlite = new DatabaseSync(":memory:");
  for (const f of migrationFiles()) sqlite.exec(readFileSync(path.join(MIGRATIONS, f), "utf8"));
  for (const [role, id] of Object.entries(USERS)) {
    sqlite.exec(`INSERT INTO users(id, email, name, role, password_hash) VALUES (${id}, '${role}@x', '${role}', '${role}', 'x')`);
  }
  sqlite.exec(`INSERT INTO catalog_items(id, code, name, uom, cogs, list_price, stock) VALUES
    (1, 'P-1', 'Pulpen', 'Pcs', 1000, 2000, 10), (2, 'K-1', 'Kertas', 'Rim', 500, 900, 5), (3, 'L-1', 'Lem', 'Pcs', 300, 600, 7)`);
  sqlite.exec(`INSERT INTO accurate_items(entity, accurate_id, code, name, uom, unit_price, units, category, suspended, run_id) VALUES
    ('PT', 1, 'P-1', 'Pulpen', 'Pcs', 2000, '[]', '', 0, 'r1'),
    ('PT', 2, 'K-1', 'Kertas', 'Rim', 900, '[]', '', 0, 'r1'),
    ('PT', 3, 'L-1', 'Lem', 'Pcs', 600, '[]', '', 0, 'r1')`);
  sqlite.exec(`INSERT INTO accurate_warehouses(entity, accurate_id, name, run_id) VALUES ('PT', 1, 'Utama', 'r1'), ('PT', 2, 'Gudang B', 'r1')`);
  sqlite.exec(`INSERT INTO accurate_stock(entity, warehouse_id, item_code, quantity, run_id) VALUES
    ('PT', 1, 'P-1', 30, 'r1'), ('PT', 2, 'P-1', 12, 'r1'), ('PT', 1, 'K-1', 5, 'r1'), ('PT', 1, 'L-1', 70, 'r1')`);
  sqlite.exec(`INSERT INTO accurate_sync_state(entity, phase, last_success_at, host) VALUES ('PT', 'idle', '${new Date().toISOString()}', 'https://zeus.accurate.id')`);
  // get-stock.do saat diajukan: angka per "kode|gudang"; tanpa angka Accurate menolak (dipakai salinan sinkron).
  const live = new Map<string, number>();
  vi.stubGlobal("fetch", (async (input: string | URL | Request) => {
    const u = new URL(String(input));
    const n = live.get(`${u.searchParams.get("no")}|${u.searchParams.get("warehouseName")}`);
    if (u.pathname.endsWith("/item/get-stock.do") && n !== undefined) return new Response(JSON.stringify({ s: true, d: { availableStock: n } }));
    return new Response(JSON.stringify({ s: false, d: ["Data tidak ditemukan"] }), { status: 404 });
  }) as typeof fetch);
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
  /** Gudang menghitung, admin meng-ACC. */
  const countAndAcc = async (itemId: number, stock: number, warehouse = "Utama", owner = "umum") => {
    expect((await req("gudang", `/api/catalog/${itemId}/stock`, "PUT", { counts: [{ warehouse, owner, stock }] })).status).toBe(200);
    expect((await req("admin", `/api/catalog/drafts/${await draftId()}/review`, "POST", { approve: true })).status).toBe(200);
  };
  return { req, q, stockOf, draftId, countAndAcc, live, db, env, sqlite };
}

const COUNT_COLS = "code, warehouse, counted, accurate_qty, accurate_source, status, counted_by, approved_by";

describe("stok katalog ikut Accurate", () => {
  it("a completed run copies Accurate's totals into the catalog, without a history row per item", async () => {
    const { q, env, sqlite, stockOf } = setup();
    sqlite.exec("UPDATE accurate_sync_state SET reconciled_at = NULL");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await syncTick(env, { deadlineMs: 5_000 });
    spy.mockRestore();
    expect(stockOf("P-1")).toBe(42); // 30 + 12 over both warehouses
    expect(stockOf("L-1")).toBe(70);
    expect(q("SELECT * FROM stock_history")).toHaveLength(0);
  });

  it("Sinkron (Tarik) copies the totals with history, also for an item that was just counted", async () => {
    const { req, q, stockOf, countAndAcc } = setup();
    await countAndAcc(3, 8);
    const res = await req("manager", "/api/stock/pull", "POST", {});
    expect(await res.json()).toMatchObject({ done: true, changed: 2, skipped: 0, entered: 0 });
    expect(stockOf("L-1")).toBe(70);
    expect(q("SELECT code, qty_before, qty_after FROM stock_history WHERE source = 'tarik' ORDER BY code")).toEqual([
      { code: "L-1", qty_before: 7, qty_after: 70 },
      { code: "P-1", qty_before: 10, qty_after: 42 },
    ]);
    expect((await req("rep", "/api/stock/pull", "POST", {})).status).toBe(403);
  });
});

describe("stok pembanding (stok mandiri)", () => {
  const COLS = "code, warehouse, owner, counted, accurate_qty, accurate_source, status, counted_by, approved_by";

  it("one draft for several warehouses and owners; ACC records each line, Accurate and catalog stock untouched", async () => {
    const { req, q, stockOf, draftId, live } = setup();
    live.set("P-1|Utama", 28);
    const res = await req("gudang", "/api/catalog/1/stock", "PUT", { counts: [
      { warehouse: "Utama", stock: 25 },
      { warehouse: "Gudang B", owner: "cv", stock: 4 },
    ] });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { count: unknown }).count).toEqual({ lines: [
      { warehouse: "Utama", owner: "umum", stock: 25, accurate: 28, accurate_source: "live" },
      { warehouse: "Gudang B", owner: "cv", stock: 4, accurate: null, accurate_source: null }, // CV: tidak ada Accurate
    ] });
    expect((await req("admin", `/api/catalog/drafts/${await draftId()}/review`, "POST", { approve: true })).status).toBe(200);
    expect(stockOf("P-1")).toBe(10);
    expect(q(`SELECT ${COLS} FROM stock_counts ORDER BY id`)).toEqual([
      { code: "P-1", warehouse: "Utama", owner: "umum", counted: 25, accurate_qty: 28, accurate_source: "live", status: "recorded", counted_by: USERS.gudang, approved_by: USERS.admin },
      { code: "P-1", warehouse: "Gudang B", owner: "cv", counted: 4, accurate_qty: null, accurate_source: null, status: "recorded", counted_by: USERS.gudang, approved_by: USERS.admin },
    ]);
    expect(q("SELECT * FROM stock_unsent")).toHaveLength(0);
    // Tidak ada tugas koreksi ke Accurate.
    expect(await (await req("admin", "/api/stock/status")).json()).toMatchObject({ open: 0 });
  });

  it("falls back to the last synced figure of that warehouse when Accurate cannot be asked", async () => {
    const { q, countAndAcc } = setup();
    await countAndAcc(1, 30);
    expect(q("SELECT accurate_qty, accurate_source FROM stock_counts")).toEqual([{ accurate_qty: 30, accurate_source: "sync" }]);
  });

  it("only Admin and Admin Gudang; one gudang is enough for now; unknown or doubled warehouse refused", async () => {
    const { req, q, draftId, sqlite } = setup();
    for (const who of ["manager", "rep"] as const) expect((await req(who, "/api/catalog/1/stock", "PUT", { counts: [{ warehouse: "Utama", stock: 3 }] })).status).toBe(403);
    expect((await req("gudang", "/api/catalog/1/stock", "PUT", { counts: [] })).status).toBe(400);
    expect((await req("gudang", "/api/catalog/1/stock", "PUT", { counts: [{ warehouse: "Utama", stock: -1 }] })).status).toBe(400);
    expect((await req("gudang", "/api/catalog/1/stock", "PUT", { counts: [{ warehouse: "Mars", stock: 1 }] })).status).toBe(400);
    expect((await req("gudang", "/api/catalog/1/stock", "PUT", { counts: [{ warehouse: "Utama", stock: 1 }, { warehouse: "utama", stock: 2 }] })).status).toBe(400);
    expect((await req("gudang", "/api/catalog/1/stock", "PUT", { counts: [{ warehouse: "Utama", stock: 3 }] })).status).toBe(200); // P-1 juga di Gudang B: belum wajib
    expect((await req("admin", "/api/catalog/1/stock", "PUT", { counts: [{ warehouse: "Utama", stock: 4 }] })).status).toBe(200); // menggantikan
    expect(q("SELECT json_extract(payload, '$.lines[0].stock') AS s FROM catalog_drafts WHERE kind = 'stock'")).toEqual([{ s: 4 }]);
    expect((await req("admin", `/api/catalog/drafts/${await draftId()}/review`, "POST", { approve: false, note: "Hitung ulang" })).status).toBe(200);
    expect(q("SELECT * FROM stock_counts")).toHaveLength(0);
    expect(q("SELECT qty_after, source, note FROM stock_history")).toEqual([{ qty_after: 4, source: "draft_rejected", note: "Hitung ulang" }]);
    void sqlite;
  });

  it("the history of an item is for Admin and Admin Gudang only", async () => {
    const { req, countAndAcc } = setup();
    await countAndAcc(1, 25);
    expect((await req("gudang", "/api/stock/counts?code=P-1")).status).toBe(200);
    expect((await req("admin", "/api/stock/counts?code=P-1")).status).toBe(200);
    expect((await req("manager", "/api/stock/counts?code=P-1")).status).toBe(403);
    const body = (await (await req("manager", "/api/stock/item?code=P-1")).json()) as { warehouses: { events: { kind: string }[] }[] };
    expect(body.warehouses.flatMap((w) => w.events).some((e) => e.kind === "count")).toBe(false);
  });

  it("older drafts still ACC: one warehouse without owner, and the one before warehouses", async () => {
    const { req, q, sqlite, draftId } = setup();
    sqlite.exec(`INSERT INTO catalog_drafts(item_id, code, kind, uom, payload, before, created_by) VALUES (1, 'P-1', 'stock', '', '{"stock":25}', '{"stock":10}', ${USERS.gudang})`);
    expect((await req("admin", `/api/catalog/drafts/${await draftId()}/review`, "POST", { approve: true })).status).toBe(200);
    sqlite.exec(`INSERT INTO catalog_drafts(item_id, code, kind, uom, payload, before, created_by) VALUES (2, 'K-1', 'stock', '', '{"stock":6,"warehouse":"Utama","accurate":5}', '{"stock":5}', ${USERS.gudang})`);
    expect((await req("admin", `/api/catalog/drafts/${await draftId()}/review`, "POST", { approve: true })).status).toBe(200);
    expect(q("SELECT code, warehouse, owner, counted, accurate_qty, status FROM stock_counts ORDER BY id")).toEqual([
      { code: "P-1", warehouse: "", owner: "umum", counted: 25, accurate_qty: 10, status: "recorded" },
      { code: "K-1", warehouse: "Utama", owner: "umum", counted: 6, accurate_qty: 5, status: "recorded" },
    ]);
  });
});

describe("Belum masuk Accurate (dimatikan; kode tetap untuk dinyalakan lagi)", () => {
  const openCount = (sqlite: DatabaseSync) =>
    sqlite.exec(`INSERT INTO stock_counts(item_id, code, warehouse, counted, accurate_qty, counted_at, counted_by, approved_by, status)
      VALUES (1, 'P-1', 'Utama', 25, 30, datetime('now'), ${USERS.gudang}, ${USERS.admin}, 'open')`);

  it("an open count still closes itself on a matching adjustment, and can be marked by an admin", async () => {
    const { req, q, sqlite } = setup();
    openCount(sqlite);
    sqlite.exec(`INSERT INTO stock_mutations(entity, accurate_id, item_no, warehouse, trans_type, trans_number, created_wib, qty)
      VALUES ('PT', 1, 'P-1', 'Utama', 'IA', 'IA.2026.11.00017', datetime('now', '+7 hours', '+1 minute'), -5)`);
    expect(await (await req("manager", "/api/stock/pull", "POST", {})).json()).toMatchObject({ entered: 1 });
    expect(q("SELECT status, entered_ref FROM stock_counts")).toEqual([{ status: "entered", entered_ref: "IA.2026.11.00017" }]);
    openCount(sqlite);
    const id = q("SELECT id FROM stock_counts WHERE status = 'open'")[0].id as number;
    expect((await req("gudang", "/api/stock/counts/done", "POST", { ids: [id] })).status).toBe(403);
    expect(await (await req("admin", "/api/stock/counts/done", "POST", { ids: [id], note: "x" })).json()).toEqual({ done: 1 });
  });
});

describe("Cocokkan", () => {
  it("lists differences, and no cost or price field", async () => {
    const { req } = setup();
    const res = await req("gudang", "/api/stock/compare");
    const body = (await res.json()) as { items: Record<string, unknown>[] };
    expect(body.items).toEqual([
      { code: "L-1", name: "Lem", uom: "Pcs", pe: 7, accurate: 70, diff: -63, unsent: false },
      { code: "P-1", name: "Pulpen", uom: "Pcs", pe: 10, accurate: 42, diff: -32, unsent: false },
    ]);
    expect(JSON.stringify(body)).not.toMatch(/cogs|list_price/);
    expect((await req("rep", "/api/stock/compare")).status).toBe(403);
  });
});

describe("gudang", () => {
  it("lists Accurate's warehouses, the default one first", async () => {
    const { req } = setup();
    expect(await (await req("gudang", "/api/stock/warehouses")).json()).toEqual({ warehouses: ["Utama", "Gudang B"], required: [] });
    // Untuk satu barang: gudang bawaan + gudang yang menurut Accurate punya stoknya (saran baris, belum wajib).
    expect(await (await req("gudang", "/api/stock/warehouses?code=P-1")).json()).toEqual({ warehouses: ["Utama", "Gudang B"], required: ["Utama", "Gudang B"] });
  });
});

describe("impor spreadsheet", () => {
  it("never writes stock on upload; ACC of the file sets it with history (source import), nothing waits to be sent", async () => {
    const { req, q, stockOf } = setup();
    const r = await req("manager", "/api/catalog/import", "POST", {
      rows: [
        { code: "P-1", name: "Pulpen", uom: "Pcs", stock: 99 },
        { code: "K-1", name: "Kertas", uom: "Rim", stock: 5 },
        { code: "B-1", name: "Baru", uom: "Pcs", stock: 4 },
      ],
    });
    expect(r.status).toBe(200);
    const up = (await r.json()) as { importId: number; drafts: number; unchanged: number };
    expect([up.drafts, up.unchanged]).toEqual([2, 1]);
    expect(stockOf("P-1")).toBe(10);
    const acc = await req("admin", `/api/catalog/imports/${up.importId}/review`, "POST", { approve: true });
    expect(acc.status).toBe(200);
    expect(stockOf("P-1")).toBe(99);
    expect(stockOf("B-1")).toBe(4);
    expect(q("SELECT code, qty_before, qty_after, source FROM stock_history ORDER BY code")).toEqual([
      { code: "B-1", qty_before: 0, qty_after: 4, source: "import" },
      { code: "P-1", qty_before: 10, qty_after: 99, source: "import" },
    ]);
    expect(q("SELECT * FROM stock_unsent")).toHaveLength(0);
  });
});

describe("migrasi 0050", () => {
  it("moves items held by the old model into open counts and releases them", () => {
    const sqlite = new DatabaseSync(":memory:");
    for (const f of migrationFiles().filter((f) => f < "0050")) sqlite.exec(readFileSync(path.join(MIGRATIONS, f), "utf8"));
    sqlite.exec(`INSERT INTO users(id, email, name, role, password_hash) VALUES (1, 'a@x', 'a', 'admin', 'x'), (2, 'g@x', 'g', 'gudang', 'x')`);
    sqlite.exec(`INSERT INTO catalog_items(id, code, name, uom, cogs, list_price, stock) VALUES (1, 'P-1', 'Pulpen', 'Pcs', 1, 2, 25)`);
    sqlite.exec(`INSERT INTO stock_history(code, uom, qty_before, qty_after, source, draft_id, filled_by, approved_by) VALUES
      ('P-1', 'Pcs', 10, 20, 'draft_approved', 7, 2, 1), ('P-1', 'Pcs', 20, 25, 'draft_approved', 8, 2, 1)`);
    sqlite.exec(`INSERT INTO stock_unsent(code) VALUES ('P-1')`);
    const f = migrationFiles().find((f) => f.startsWith("0050"))!;
    sqlite.exec(readFileSync(path.join(MIGRATIONS, f), "utf8"));
    expect(sqlite.prepare("SELECT item_id, code, warehouse, counted, accurate_qty, draft_id, status, counted_by, approved_by FROM stock_counts").all()).toEqual([
      { item_id: 1, code: "P-1", warehouse: "", counted: 25, accurate_qty: null, draft_id: 8, status: "open", counted_by: 2, approved_by: 1 },
    ]);
    expect(sqlite.prepare("SELECT * FROM stock_unsent").all()).toHaveLength(0);
  });
});

describe("riwayat stok per barang dan stok minus", () => {
  it("lists minus stock per warehouse, even when the total over warehouses is positive; no cost field", async () => {
    const { req, sqlite } = setup();
    sqlite.exec("UPDATE accurate_stock SET quantity = -3 WHERE item_code = 'P-1' AND warehouse_id = 2"); // Utama 30, Gudang B -3
    const body = (await (await req("gudang", "/api/stock/minus")).json()) as { items: Record<string, unknown>[] };
    expect(body.items).toEqual([expect.objectContaining({ code: "P-1", name: "Pulpen", warehouse: "Gudang B", qty: -3 })]);
    expect(JSON.stringify(body)).not.toMatch(/cogs|list_price|item_cost/);
    expect((await req("rep", "/api/stock/minus")).status).toBe(403);
  });

  it("gives each warehouse its movements with the balance walked back from Accurate's stock, and the cycle counts", async () => {
    const { req, sqlite, countAndAcc } = setup();
    sqlite.exec("UPDATE accurate_stock SET quantity = -5, synced_at = datetime('now') WHERE item_code = 'L-1'");
    sqlite.exec(`INSERT INTO stock_mutations(entity, accurate_id, item_no, warehouse, trans_type, trans_number, trans_date, created_wib, qty, item_cost) VALUES
      ('PT', 1, 'L-1', 'Utama', 'DO', 'DO.1', date('now', '+7 hours', '-2 days'), datetime('now', '+7 hours', '-2 days'), -10, 999),
      ('PT', 2, 'L-1', 'Utama', 'DO', 'DO.2', date('now', '+7 hours', '-2 days'), datetime('now', '+7 hours', '-1 days'), -7, 999)`);
    await countAndAcc(3, 4);
    const res = await req("gudang", "/api/stock/item?code=L-1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { warehouses: { warehouse: string; accurate: number; events: Record<string, unknown>[] }[] };
    expect(JSON.stringify(body)).not.toMatch(/item_cost|cogs|list_price|999/);
    const u = body.warehouses.find((w) => w.warehouse === "Utama")!;
    expect(u.accurate).toBe(-5);
    const muts = u.events.filter((e) => e.kind === "mutation") as { m: { number: string }; balance: number; wentNegative: boolean; backdated: boolean }[];
    expect(muts.map((e) => [e.m.number, e.balance, e.wentNegative, e.backdated])).toEqual([
      ["DO.2", -5, true, true],
      ["DO.1", 2, false, false],
    ]);
    expect(u.events.find((e) => e.kind === "count")).toMatchObject({ c: { counted: 4 }, balance: -5, gap: 9 });
    expect((await req("gudang", "/api/stock/item")).status).toBe(400);
  });
});

describe("migrasi 0052", () => {
  it("adds owner 'umum' to every count and turns waiting ones into recorded stock-book entries", () => {
    const sqlite = new DatabaseSync(":memory:");
    for (const f of migrationFiles().filter((f) => f < "0052")) sqlite.exec(readFileSync(path.join(MIGRATIONS, f), "utf8"));
    sqlite.exec(`INSERT INTO stock_counts(code, warehouse, counted, counted_at, status) VALUES ('A', 'Utama', 5, '2026-11-25 01:00:00', 'open'), ('B', 'Utama', 6, '2026-11-25 01:00:00', 'entered')`);
    sqlite.exec(readFileSync(path.join(MIGRATIONS, migrationFiles().find((f) => f.startsWith("0052"))!), "utf8"));
    expect(sqlite.prepare("SELECT code, owner, status FROM stock_counts ORDER BY code").all()).toEqual([
      { code: "A", owner: "umum", status: "recorded" },
      { code: "B", owner: "umum", status: "entered" },
    ]);
  });
});
