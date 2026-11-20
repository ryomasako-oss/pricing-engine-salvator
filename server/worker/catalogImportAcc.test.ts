import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { D1DatabaseShim } from "../../scripts/d1-sqlite-shim";
import { catalogRouter } from "./routes/catalog";
import { forgetCatalogIndex } from "./catalogSearchIndex";
import { importChanges } from "../../shared/catalogImport";
import type { Env } from "./env";

/* 2026-11-20: an import file only makes drafts; an admin ACCs one item, some, or the whole file, and that
   applies it with the rules the direct import always had (merge / replace, purchased COGS, units, stock). */

const USERS = { admin: 1, manager: 2, gudang: 3 } as const;
type Who = keyof typeof USERS;

function setup() {
  forgetCatalogIndex();
  const sqlite = new DatabaseSync(":memory:");
  const dir = path.resolve(import.meta.dirname, "../../migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(path.join(dir, f), "utf8"));
  for (const [role, id] of Object.entries(USERS)) {
    sqlite.exec(`INSERT INTO users(id, email, name, role, password_hash) VALUES (${id}, '${role}@x', '${role}', '${role}', 'x')`);
  }
  sqlite.exec(`INSERT INTO catalog_items(id, code, name, uom, cogs, list_price, stock, category) VALUES
    (1, 'KEEP', 'Dibeli', 'Pcs', 2083, 3000, 5, 'ATK'),
    (2, 'PLAIN', 'Biasa', 'Box', 700, 900, 2, 'ATK'),
    (3, 'GONE', 'Tidak di file', 'Pcs', 100, 200, 1, ''),
    (4, 'SAME', 'Sama', 'Pcs', 10, 20, 3, '')`);
  sqlite.exec(`INSERT INTO catalog_item_uoms(code, uom, factor) VALUES ('PLAIN', 'Lusin', 12), ('GONE', 'Box', 10)`);
  sqlite.exec(`INSERT INTO accurate_receipt_lines(entity, receipt_id, line_id, trans_date, item_code, quantity, unit_price)
    VALUES ('PT', 309, 1, '2026-10-16', 'KEEP', 12, 2083)`);
  let who: Who = "manager";
  const app = new Hono<Env>();
  app.use(async (c, next) => {
    c.set("user", { id: USERS[who], email: `${who}@x`, name: who, role: who } as never);
    await next();
  });
  app.route("/api/catalog", catalogRouter);
  const env = { DB: new D1DatabaseShim(sqlite) as unknown as D1Database } as unknown as Env["Bindings"];
  const req = async (as: Who, method: string, p: string, body?: unknown) => {
    who = as;
    const r = await app.request(p, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }, env);
    return { status: r.status, json: (await r.json()) as Record<string, any> };
  };
  const q = (sql: string, ...a: (string | number)[]) => sqlite.prepare(sql).all(...a) as Record<string, any>[];
  const items = () => q("SELECT code, name, uom, cogs, list_price, stock, category FROM catalog_items ORDER BY code");
  const upload = (as: Who, rows: unknown[], mode: "merge" | "replace" = "merge") => req(as, "POST", "/api/catalog/import", { rows, mode, source: "file.xlsx" });
  const acc = (importId: number, body: Record<string, unknown> = {}) => req("admin", "POST", `/api/catalog/imports/${importId}/review`, { approve: true, ...body });
  const draftId = (code: string) => q("SELECT id FROM catalog_drafts WHERE code = ? AND kind = 'import'", code)[0].id as number;
  return { req, q, items, upload, acc, draftId, sqlite };
}

const FILE = [
  { code: "KEEP", name: "Dibeli", cogs: 1800, list_price: 3100 },
  { code: "PLAIN", name: "Biasa baru", cogs: 0, list_price: 0, units: [{ uom: "Dus", factor: 6 }] },
  { code: "FRESH", name: "Dari file", uom: "Rim", cogs: 50, list_price: 80, stock: 7 },
  { code: "SAME", name: "Sama", cogs: 10, list_price: 20 },
];

describe("unggah impor", () => {
  it("leaves the catalog alone, drafts every changed row, skips unchanged rows, and lets a manager upload", async () => {
    const { items, upload, q } = setup();
    const before = items();
    const r = await upload("manager", FILE);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ drafts: 3, unchanged: 1, inserted: 1, updated: 2, total: 4 });
    expect(items()).toEqual(before);
    expect(q("SELECT code, status, import_id, created_by FROM catalog_drafts ORDER BY code")).toEqual([
      { code: "FRESH", status: "pending", import_id: r.json.importId, created_by: USERS.manager },
      { code: "KEEP", status: "pending", import_id: r.json.importId, created_by: USERS.manager },
      { code: "PLAIN", status: "pending", import_id: r.json.importId, created_by: USERS.manager },
    ]);
    expect(q("SELECT source, mode, rows FROM catalog_imports")).toEqual([{ source: "file.xlsx", mode: "merge", rows: 4 }]);
  });

  it("an all-unchanged file makes no import at all", async () => {
    const { upload, q } = setup();
    const r = await upload("manager", [{ code: "SAME", name: "Sama", cogs: 10, list_price: 20 }]);
    expect(r.json).toMatchObject({ importId: null, drafts: 0, unchanged: 1 });
    expect(q("SELECT * FROM catalog_imports")).toHaveLength(0);
  });

  it("a second file for the same code takes over its waiting draft", async () => {
    const { upload, q } = setup();
    await upload("manager", [{ code: "PLAIN", name: "Satu" }]);
    const b = await upload("manager", [{ code: "PLAIN", name: "Dua" }]);
    const rows = q("SELECT import_id, payload FROM catalog_drafts WHERE code = 'PLAIN'");
    expect(rows).toHaveLength(1);
    expect([rows[0].import_id, JSON.parse(rows[0].payload).name]).toEqual([b.json.importId, "Dua"]);
  });

  it("writes a big file in batches, not one query per row", async () => {
    const { upload, q, acc } = setup();
    const rows = Array.from({ length: 700 }, (_, i) => ({ code: `BULK-${i}`, name: `Barang ${i}`, cogs: 10, list_price: 20, stock: i }));
    const r = await upload("manager", rows);
    expect(r.json.drafts).toBe(700);
    const a = await acc(r.json.importId);
    expect(a.json).toMatchObject({ ok: true, count: 700 });
    expect(q("SELECT COUNT(*) AS n FROM catalog_items WHERE code LIKE 'BULK-%'")[0].n).toBe(700);
    expect(q("SELECT COUNT(*) AS n FROM stock_history WHERE source = 'import'")[0].n).toBe(699); // BULK-0 stock 0 = same as the new item
  });
});

describe("ACC impor", () => {
  it("whole file merge gives the same result the direct import gave (purchased COGS kept, units, stock)", async () => {
    const { items, upload, acc, q } = setup();
    const r = await upload("manager", FILE);
    const a = await acc(r.json.importId);
    expect(a.json).toMatchObject({ ok: true, count: 3, cogsFromPurchases: 1 });
    expect(items()).toEqual([
      { code: "FRESH", name: "Dari file", uom: "Rim", cogs: 50, list_price: 80, stock: 7, category: "" },
      { code: "GONE", name: "Tidak di file", uom: "Pcs", cogs: 100, list_price: 200, stock: 1, category: "" },
      { code: "KEEP", name: "Dibeli", uom: "Pcs", cogs: 2083, list_price: 3100, stock: 5, category: "ATK" },
      { code: "PLAIN", name: "Biasa baru", uom: "Box", cogs: 700, list_price: 900, stock: 2, category: "ATK" },
      { code: "SAME", name: "Sama", uom: "Pcs", cogs: 10, list_price: 20, stock: 3, category: "" },
    ]);
    expect(q("SELECT code, uom, factor FROM catalog_item_uoms ORDER BY code, uom")).toEqual([
      { code: "GONE", uom: "Box", factor: 10 },
      { code: "PLAIN", uom: "Dus", factor: 6 },
    ]);
    expect(q("SELECT status, reviewed_by FROM catalog_drafts GROUP BY status")).toEqual([{ status: "approved", reviewed_by: USERS.admin }]);
    // One audit row per draft, with its id.
    const audits = q("SELECT detail FROM audit_log WHERE action = 'catalog_draft_approved'").map((x) => JSON.parse(x.detail));
    expect(audits.map((d) => d.code).sort()).toEqual(["FRESH", "KEEP", "PLAIN"]);
    expect(audits.every((d) => typeof d.draft_id === "number" && d.kind === "import")).toBe(true);
    expect(q("SELECT stock FROM catalog_items WHERE code = 'FRESH'")[0].stock).toBe(7);
    expect(q("SELECT source, qty_before, qty_after FROM stock_history")).toEqual([{ source: "import", qty_before: 0, qty_after: 7 }]);
    expect(q("SELECT code FROM stock_unsent")).toEqual([{ code: "FRESH" }]);
  });

  it("one item, then some, then the rest of the file", async () => {
    const { items, upload, acc, draftId, q, req } = setup();
    const r = await upload("manager", FILE);
    const one = await req("admin", "POST", `/api/catalog/drafts/${draftId("FRESH")}/review`, { approve: true });
    expect(one.status).toBe(200);
    expect(items().map((i) => i.code)).toContain("FRESH");
    expect(q("SELECT name FROM catalog_items WHERE code = 'PLAIN'")[0].name).toBe("Biasa");
    const some = await acc(r.json.importId, { ids: [draftId("KEEP")] });
    expect(some.json.count).toBe(1);
    expect(q("SELECT list_price FROM catalog_items WHERE code = 'KEEP'")[0].list_price).toBe(3100);
    expect(q("SELECT name FROM catalog_items WHERE code = 'PLAIN'")[0].name).toBe("Biasa");
    const rest = await acc(r.json.importId);
    expect(rest.json.count).toBe(1);
    expect(q("SELECT name FROM catalog_items WHERE code = 'PLAIN'")[0].name).toBe("Biasa baru");
    expect((await acc(r.json.importId)).status).toBe(409); // nothing waits any more
  });

  it("replace: the file wins, items it leaves out are delete drafts in the same import, and ACC pauses new Accurate items", async () => {
    const { items, upload, acc, q, draftId } = setup();
    const r = await upload("admin", FILE, "replace");
    expect(r.json).toMatchObject({ drafts: 4, removed: 1, inserted: 1, updated: 2, unchanged: 1 });
    expect(q("SELECT payload FROM catalog_drafts WHERE code = 'GONE'")[0].payload).toBe('{"delete":true}');

    // Part of the file first: the delete waits with the rest, nothing is half-deleted.
    await acc(r.json.importId, { ids: [draftId("PLAIN")] });
    expect(items().map((i) => i.code)).toContain("GONE");
    expect(q("SELECT * FROM settings WHERE key = 'accurate_new_items_paused'")).toHaveLength(1);

    await acc(r.json.importId);
    expect(items()).toEqual([
      { code: "FRESH", name: "Dari file", uom: "Rim", cogs: 50, list_price: 80, stock: 7, category: "" },
      { code: "KEEP", name: "Dibeli", uom: "Pcs", cogs: 2083, list_price: 3100, stock: 5, category: "" },
      { code: "PLAIN", name: "Biasa baru", uom: "Box", cogs: 0, list_price: 0, stock: 2, category: "" },
      { code: "SAME", name: "Sama", uom: "Pcs", cogs: 10, list_price: 20, stock: 3, category: "" },
    ]);
    expect(q("SELECT code, uom, factor FROM catalog_item_uoms")).toEqual([{ code: "PLAIN", uom: "Dus", factor: 6 }]);
  });
});

describe("tolak dan izin", () => {
  it("reject of the whole file needs a reason, leaves the catalog alone, and closes the drafts", async () => {
    const { req, items, upload, q } = setup();
    const before = items();
    const r = await upload("manager", FILE);
    const url = `/api/catalog/imports/${r.json.importId}/review`;
    expect((await req("admin", "POST", url, { approve: false })).status).toBe(400);
    const no = await req("admin", "POST", url, { approve: false, note: "Harga salah" });
    expect(no.json).toMatchObject({ ok: true, count: 3 });
    expect(items()).toEqual(before);
    expect(q("SELECT DISTINCT status, note FROM catalog_drafts")).toEqual([{ status: "rejected", note: "Harga salah" }]);
    expect(q("SELECT COUNT(*) AS n FROM stock_history")[0].n).toBe(0);
  });

  it("a manager uploads but cannot ACC or reject; Admin Gudang cannot upload", async () => {
    const { req, upload, items } = setup();
    const before = items();
    const r = await upload("manager", FILE);
    for (const body of [{ approve: true }, { approve: false, note: "x" }]) {
      expect((await req("manager", "POST", `/api/catalog/imports/${r.json.importId}/review`, body)).status).toBe(403);
    }
    expect((await req("gudang", "POST", `/api/catalog/imports/${r.json.importId}/review`, { approve: true })).status).toBe(403);
    expect((await upload("gudang", FILE)).status).toBe(403);
    expect(items()).toEqual(before);
  });

  it("an admin's own upload still waits for an ACC (by that admin or another)", async () => {
    const { upload, items, acc } = setup();
    const before = items();
    const r = await upload("admin", FILE);
    expect(items()).toEqual(before);
    expect((await acc(r.json.importId)).status).toBe(200);
    expect(items().find((i) => i.code === "FRESH")).toBeTruthy();
  });
});

describe("daftar di Gudang", () => {
  it("lists files with counts, pages their drafts, and hides cost and price from a role without view_costs", async () => {
    const { req, upload, acc } = setup();
    const r = await upload("manager", FILE);
    const list = await req("admin", "GET", "/api/catalog/imports");
    expect(list.json.imports).toMatchObject([{ id: r.json.importId, source: "file.xlsx", mode: "merge", created_by_name: "manager", total: 3, pending: 3 }]);
    // The normal draft list no longer carries the file's rows.
    expect((await req("admin", "GET", "/api/catalog/drafts")).json.drafts).toHaveLength(0);
    const page = await req("admin", "GET", `/api/catalog/imports/${r.json.importId}/drafts?limit=2`);
    expect(page.json.total).toBe(3);
    expect(page.json.drafts).toHaveLength(2);
    expect(page.json.drafts[0].payload).toHaveProperty("cogs");

    await acc(r.json.importId);
    expect((await req("admin", "GET", "/api/catalog/imports")).json.imports).toHaveLength(0);
    expect((await req("admin", "GET", "/api/catalog/imports?status=done")).json.imports).toMatchObject([{ approved: 3, pending: 0 }]);
  });

  it("importChanges reads before → after in words; a viewer without costs gets no money lines", () => {
    const before = { name: "Biasa", uom: "Box", cogs: 700, list_price: 900, stock: 2, category: "ATK", units: [] };
    expect(importChanges({ code: "P", name: "Biasa baru", cogs: 0, list_price: 950, mode: "merge" }, before)).toEqual([
      "Nama: Biasa → Biasa baru",
      "Harga jual: 900 → 950",
    ]);
    const { cogs: _c, list_price: _p, ...hidden } = before;
    expect(importChanges({ code: "P", name: "Biasa baru", cogs: 5, list_price: 950, mode: "merge" }, hidden)).toEqual(["Nama: Biasa → Biasa baru"]);
    expect(importChanges({ delete: true }, before)[0]).toMatch(/^Dihapus/);
  });
});
