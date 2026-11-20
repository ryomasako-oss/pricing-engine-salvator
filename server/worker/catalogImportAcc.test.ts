import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { D1DatabaseShim } from "../../scripts/d1-sqlite-shim";
import { catalogRouter } from "./routes/catalog";
import { stockRouter } from "./routes/stock";
import { forgetCatalogIndex } from "./catalogSearchIndex";
import { importChanges, importQueuedNote } from "../../shared/catalogImport";
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
  app.route("/api/stock", stockRouter);
  // D1 counts every call of a request. A batch is one call; `hooks.beforeBatch` can fail it or act as "another admin".
  const stats = { prepares: 0, batches: 0, batchStatements: 0 };
  const hooks: { beforeBatch?: (n: number) => void } = {};
  const shim = new D1DatabaseShim(sqlite);
  const counted = new Proxy(shim, {
    get(t, k) {
      if (k === "prepare") return (sql: string) => (stats.prepares++, t.prepare(sql));
      if (k === "batch") {
        return (s: D1PreparedStatement[]) => {
          stats.batches++;
          stats.batchStatements += s.length;
          hooks.beforeBatch?.(stats.batches);
          return t.batch(s);
        };
      }
      return undefined;
    },
  });
  const queries = () => stats.prepares - stats.batchStatements + stats.batches;
  const env = { DB: counted as unknown as D1Database } as unknown as Env["Bindings"];
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
  return { req, q, items, upload, acc, draftId, sqlite, stats, hooks, queries };
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

  it("writes a big file in batches, not one query per row", async () => {
    const { upload, q, acc } = setup();
    const rows = Array.from({ length: 700 }, (_, i) => ({ code: `BULK-${i}`, name: `Barang ${i}`, cogs: 10, list_price: 20, stock: i }));
    const r = await upload("manager", rows);
    expect(r.json.drafts).toBe(700);
    // ACC goes ACC_STEP (120) rows per call; the page repeats until none remain.
    let applied = 0;
    for (;;) {
      const a = await acc(r.json.importId);
      expect(a.json.ok).toBe(true);
      applied += a.json.count;
      if (!a.json.remaining) break;
    }
    expect(applied).toBe(700);
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
    const { items, upload, acc, draftId, q } = setup();
    const r = await upload("manager", FILE);
    const one = await acc(r.json.importId, { ids: [draftId("FRESH")] });
    expect(one.json.count).toBe(1);
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

  it("replace: the file wins; items the file leaves out go at the last ACC, which also pauses new Accurate items; a partial ACC does neither", async () => {
    const { items, upload, acc, q, draftId } = setup();
    const r = await upload("admin", FILE, "replace");
    expect(r.json).toMatchObject({ drafts: 3, removed: 1, inserted: 1, updated: 2, unchanged: 1 });
    expect(q("SELECT COUNT(*) AS n FROM catalog_drafts WHERE payload LIKE '%delete%'")[0].n).toBe(0);

    const part = await acc(r.json.importId, { ids: [draftId("PLAIN")] });
    expect(part.json).toMatchObject({ applied: 1, remaining: 2 });
    expect(part.json.removed).toBeUndefined();
    expect(items().map((i) => i.code)).toContain("GONE");
    expect(q("SELECT * FROM settings WHERE key = 'accurate_new_items_paused'")).toHaveLength(0);

    const rest = await acc(r.json.importId);
    expect(rest.json).toMatchObject({ applied: 2, remaining: 0, removed: 1 });
    expect(items()).toEqual([
      { code: "FRESH", name: "Dari file", uom: "Rim", cogs: 50, list_price: 80, stock: 7, category: "" },
      { code: "KEEP", name: "Dibeli", uom: "Pcs", cogs: 2083, list_price: 3100, stock: 5, category: "" },
      { code: "PLAIN", name: "Biasa baru", uom: "Box", cogs: 0, list_price: 0, stock: 2, category: "" },
      { code: "SAME", name: "Sama", uom: "Pcs", cogs: 10, list_price: 20, stock: 3, category: "" },
    ]);
    expect(q("SELECT code, uom, factor FROM catalog_item_uoms")).toEqual([{ code: "PLAIN", uom: "Dus", factor: 6 }]);
    expect(q("SELECT * FROM settings WHERE key = 'accurate_new_items_paused'")).toHaveLength(1);
    expect(q("SELECT done_at IS NOT NULL AS done, removed FROM catalog_imports")).toEqual([{ done: 1, removed: 1 }]);
    expect(q("SELECT COUNT(*) AS n FROM catalog_import_codes")[0].n).toBe(0);
  });

  it("replace: what is deleted is worked out at ACC, from the catalog as it is then", async () => {
    const { items, upload, acc, sqlite } = setup();
    const r = await upload("admin", FILE, "replace");
    sqlite.exec("INSERT INTO catalog_items(code, name, uom) VALUES ('LATE', 'Masuk sesudah unggah', 'Pcs')");
    sqlite.exec("DELETE FROM catalog_items WHERE code = 'GONE'");
    const a = await acc(r.json.importId);
    expect(a.json.removed).toBe(1);
    expect(items().map((i) => i.code)).not.toContain("LATE");
  });

  it("replace whose rows all equal the catalog still exists and its ACC deletes and pauses", async () => {
    const { items, upload, acc, q, req } = setup();
    const all = items().filter((i) => i.code !== "GONE").map((i) => ({ code: i.code, name: i.name, uom: i.uom, cogs: i.cogs, list_price: i.list_price, stock: i.stock, category: i.category }));
    const r = await upload("admin", all, "replace");
    expect(r.json).toMatchObject({ drafts: 0, removed: 1 });
    expect(r.json.importId).toBeTruthy();
    const list = await req("admin", "GET", "/api/catalog/imports");
    expect(list.json.imports).toMatchObject([{ id: r.json.importId, mode: "replace", total: 0, pending: 0, removing: 1 }]);
    const a = await acc(r.json.importId);
    expect(a.json).toMatchObject({ ok: true, applied: 0, remaining: 0, removed: 1 });
    expect(items().map((i) => i.code)).not.toContain("GONE");
    expect(q("SELECT * FROM settings WHERE key = 'accurate_new_items_paused'")).toHaveLength(1);
    expect((await acc(r.json.importId)).status).toBe(409);
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
  });
});

describe("tanda mirip barang katalog", () => {
  it("a new item names catalog items with a similar name; an existing code or an unrelated name gets none", async () => {
    const { upload, req } = setup();
    const r = await upload("manager", [
      { code: "BARU-1", name: "Biasa", uom: "Box", cogs: 1, list_price: 2 },
      { code: "BARU-2", name: "Zebra ungu langka", uom: "Pcs", cogs: 1, list_price: 2 },
      { code: "KEEP", name: "Dibeli", cogs: 1800, list_price: 3100 },
    ]);
    const list = await req("admin", "GET", `/api/catalog/imports/${r.json.importId}/drafts`);
    const by = Object.fromEntries((list.json.drafts as { code: string; similar: unknown }[]).map((d) => [d.code, d.similar]));
    expect(by["BARU-1"]).toEqual([{ code: "PLAIN", name: "Biasa" }]);
    expect(by["BARU-2"]).toEqual([]);
    expect(by.KEEP).toEqual([]);
  });
});

const BULK = (n: number, tag = "B") => Array.from({ length: n }, (_, i) => ({ code: `${tag}-${i}`, name: `Barang ${tag} ${i}`, cogs: 10, list_price: 20, stock: i + 1 }));

describe("ACC yang putus di tengah", () => {
  it("batch ke-2 gagal: yang tertulis berstatus approved, sisanya tetap pending dan bisa di-ACC ulang", async () => {
    const { upload, acc, q, hooks, stats } = setup();
    const r = await upload("manager", BULK(150));
    const base = stats.batches;
    hooks.beforeBatch = (n) => {
      if (n === base + 2) throw new Error("Too many API requests by single worker invocation");
    };
    const failed = await acc(r.json.importId);
    expect(failed.status).toBe(500);
    expect(failed.json).toMatchObject({ applied: 60, remaining: 90 });
    // What is approved is exactly what is written.
    const written = q("SELECT COUNT(*) AS n FROM catalog_items WHERE code LIKE 'B-%'")[0].n;
    expect(written).toBe(60);
    expect(q("SELECT COUNT(*) AS n FROM catalog_drafts WHERE status = 'approved'")[0].n).toBe(written);
    expect(q("SELECT COUNT(*) AS n FROM catalog_drafts WHERE status = 'pending'")[0].n).toBe(90);
    expect(q("SELECT COUNT(*) AS n FROM stock_history WHERE source = 'import'")[0].n).toBe(60);

    hooks.beforeBatch = undefined;
    const again = await acc(r.json.importId);
    expect(again.json).toMatchObject({ applied: 90, remaining: 0 });
    expect(q("SELECT COUNT(*) AS n FROM catalog_items WHERE code LIKE 'B-%'")[0].n).toBe(150);
    expect(q("SELECT COUNT(*) AS n FROM catalog_drafts WHERE status = 'approved'")[0].n).toBe(150);
    expect(q("SELECT COUNT(*) AS n FROM stock_history WHERE source = 'import'")[0].n).toBe(150);
    expect(q("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'catalog_draft_approved'")[0].n).toBe(150);
  });

  it("a draft another admin claimed in the meantime is not applied twice", async () => {
    const { upload, acc, q, hooks, sqlite, stats } = setup();
    const r = await upload("manager", [{ code: "RACE-1", name: "Satu", cogs: 5, list_price: 6, stock: 4 }, { code: "RACE-2", name: "Dua", cogs: 5, list_price: 6 }]);
    const base = stats.batches;
    hooks.beforeBatch = (n) => {
      // The other admin's ACC of RACE-1 lands (item written, draft approved) just before ours.
      if (n === base + 1) {
        sqlite.exec(`INSERT INTO catalog_items(code, name, uom, stock) VALUES ('RACE-1', 'Satu', 'Pcs', 4)`);
        sqlite.exec(`UPDATE catalog_drafts SET status = 'approved', claim = 'lain' WHERE code = 'RACE-1'`);
      }
    };
    const a = await acc(r.json.importId);
    expect(a.json).toMatchObject({ applied: 1, remaining: 0 });
    expect(q("SELECT COUNT(*) AS n FROM stock_history WHERE code = 'RACE-1'")[0].n).toBe(0);
    expect(q("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'catalog_draft_approved'")[0].n).toBe(1);
    expect(q("SELECT name FROM catalog_items WHERE code = 'RACE-2'")).toHaveLength(1);
  });
});

describe("dua impor untuk kode yang sama", () => {
  it("each file keeps its own draft; the list flags the other file; ACC of the newer one cancels the older with a note", async () => {
    const { upload, req, acc, q } = setup();
    const a = await upload("manager", [{ code: "PLAIN", name: "Satu" }]);
    const b = await upload("manager", [{ code: "PLAIN", name: "Dua" }]);
    expect(q("SELECT import_id, status FROM catalog_drafts WHERE code = 'PLAIN' ORDER BY id")).toEqual([
      { import_id: a.json.importId, status: "pending" },
      { import_id: b.json.importId, status: "pending" },
    ]);
    const list = await req("admin", "GET", `/api/catalog/imports/${a.json.importId}/drafts`);
    expect(list.json.drafts[0].elsewhere).toEqual(["file.xlsx"]);

    await acc(b.json.importId);
    expect(q("SELECT name FROM catalog_items WHERE code = 'PLAIN'")[0].name).toBe("Dua");
    expect(q("SELECT status, note FROM catalog_drafts WHERE import_id = ?", a.json.importId)).toEqual([{ status: "cancelled", note: "Digantikan file file.xlsx" }]);
    // The older file has nothing left to ACC, so it is closed and cannot overwrite the newer one.
    expect((await acc(a.json.importId)).status).toBe(409);
    expect(q("SELECT name FROM catalog_items WHERE code = 'PLAIN'")[0].name).toBe("Dua");
    expect((await req("admin", "GET", "/api/catalog/imports")).json.imports).toHaveLength(0);
  });

  it("the older file ACCed first still applies, then the newer one lands on top", async () => {
    const { upload, acc, q } = setup();
    const a = await upload("manager", [{ code: "PLAIN", name: "Satu" }]);
    const b = await upload("manager", [{ code: "PLAIN", name: "Dua" }]);
    await acc(a.json.importId);
    expect(q("SELECT name FROM catalog_items WHERE code = 'PLAIN'")[0].name).toBe("Satu");
    await acc(b.json.importId);
    expect(q("SELECT name FROM catalog_items WHERE code = 'PLAIN'")[0].name).toBe("Dua");
    expect(q("SELECT status FROM catalog_drafts ORDER BY id").map((x) => x.status)).toEqual(["approved", "approved"]);
  });
});

describe("COGS dari harga beli Accurate", () => {
  it("the list says the COGS stays; the upload reply counts it; a file that differs only there says so honestly", async () => {
    const { upload, req, q } = setup();
    const r = await upload("manager", [{ code: "KEEP", name: "Dibeli", cogs: 1800, list_price: 3100 }]);
    expect(r.json).toMatchObject({ drafts: 1, cogsIgnored: 1 });
    const list = await req("admin", "GET", `/api/catalog/imports/${r.json.importId}/drafts`);
    expect(list.json.drafts[0]).toMatchObject({ code: "KEEP", purchased: true });
    expect(importChanges(list.json.drafts[0].payload, list.json.drafts[0].before, true)).toEqual(["COGS tetap: harga beli Accurate", "Harga jual: 3.000 → 3.100"]);
    expect(importQueuedNote(r.json as never, true)).toMatch(/COGS berbeda di file.*tetap/);

    const only = await upload("manager", [{ code: "KEEP", name: "Dibeli", cogs: 1800, list_price: 3000 }]);
    expect(only.json).toMatchObject({ importId: null, drafts: 0, cogsIgnored: 1 });
    expect(importQueuedNote(only.json as never, true)).toMatch(/^Tidak ada yang berubah di katalog.*COGS berbeda di file/);
    expect(q("SELECT COUNT(*) AS n FROM catalog_imports")[0].n).toBe(1);
    // The same item without a purchase price still shows its COGS as changing.
    expect(importChanges({ code: "PLAIN", name: "Biasa", cogs: 800, mode: "merge" }, { name: "Biasa", uom: "Box", cogs: 700, list_price: 900, stock: 2, category: "ATK", units: [] })).toEqual(["COGS: 700 → 800"]);
  });
});

describe("manajer melihat impornya", () => {
  it("lists their own files with status and the rejection reason, per file and per item; not another manager's; no ACC", async () => {
    const { upload, req } = setup();
    const r = await upload("manager", FILE);
    await upload("manager", [{ code: "SAME", name: "Lain", cogs: 10, list_price: 20 }]);
    expect((await req("admin", "POST", `/api/catalog/imports/${r.json.importId}/review`, { approve: false, ids: [], note: "x" })).status).toBe(409);
    const one = await req("admin", "GET", `/api/catalog/imports/${r.json.importId}/drafts`);
    const keep = one.json.drafts.find((d: { code: string }) => d.code === "KEEP");
    await req("admin", "POST", `/api/catalog/imports/${r.json.importId}/review`, { approve: false, ids: [keep.id], note: "Harga salah" });
    await req("admin", "POST", `/api/catalog/imports/${r.json.importId}/review`, { approve: true });

    const mine = await req("manager", "GET", "/api/catalog/imports?status=all");
    expect(mine.status).toBe(200);
    expect(mine.json.imports).toHaveLength(2);
    expect(mine.json.imports.find((i: { id: number }) => i.id === r.json.importId)).toMatchObject({ approved: 2, rejected: 1, note: "Harga salah", pending: 0 });
    const items = await req("manager", "GET", `/api/catalog/imports/${r.json.importId}/drafts?status=all`);
    expect(items.status).toBe(200);
    expect(items.json.drafts.map((d: { code: string; status: string; note: string }) => [d.code, d.status, d.note])).toEqual(
      expect.arrayContaining([["KEEP", "rejected", "Harga salah"], ["FRESH", "approved", ""]]),
    );
    expect((await req("manager", "POST", `/api/catalog/imports/${r.json.importId}/review`, { approve: true })).status).toBe(403);
    // An Admin Gudang uploads nothing and sees no import files.
    expect((await req("gudang", "GET", "/api/catalog/imports")).status).toBe(403);
  });

  it("another manager's file is not found for a manager", async () => {
    const { upload, req, sqlite } = setup();
    const r = await upload("manager", FILE);
    sqlite.exec("UPDATE catalog_imports SET created_by = 1");
    expect((await req("manager", "GET", `/api/catalog/imports/${r.json.importId}/drafts`)).status).toBe(404);
    expect((await req("manager", "GET", "/api/catalog/imports?status=all")).json.imports).toHaveLength(0);
  });
});

describe("baris impor lewat /drafts/:id/review", () => {
  it("is refused for an import draft, which stays pending and can be ACCed with its file", async () => {
    const { upload, req, draftId, acc, q } = setup();
    const r = await upload("manager", FILE);
    const id = draftId("FRESH");
    for (const approve of [true, false]) {
      expect((await req("admin", "POST", `/api/catalog/drafts/${id}/review`, { approve, note: "x" })).status).toBe(400);
    }
    expect(q("SELECT status FROM catalog_drafts WHERE id = ?", id)).toEqual([{ status: "pending" }]);
    expect((await req("manager", "POST", `/api/catalog/drafts/${id}/cancel`, {})).status).toBe(404);
    expect((await acc(r.json.importId, { ids: [id] })).json.count).toBe(1);
  });
});

describe("lencana menu", () => {
  it("counts an import file as one, however many items it holds", async () => {
    const { upload, req, acc } = setup();
    const a = await upload("manager", BULK(30));
    await upload("manager", BULK(5, "C"));
    expect((await req("admin", "GET", "/api/catalog/drafts/count")).json.pending).toBe(2);
    expect((await req("manager", "GET", "/api/catalog/drafts/count")).json.pending).toBe(2);
    await acc(a.json.importId);
    expect((await req("admin", "GET", "/api/catalog/drafts/count")).json.pending).toBe(1);
  });
});

describe("riwayat stok", () => {
  it("one big import does not fill the all-items history", async () => {
    const { upload, acc, req, sqlite } = setup();
    const r = await upload("manager", BULK(100));
    await acc(r.json.importId);
    sqlite.exec(`INSERT INTO stock_history(code, uom, qty_before, qty_after, source) VALUES ('KEEP', 'Pcs', 5, 6, 'tarik')`);
    const all = (await req("admin", "GET", "/api/stock/history")).json.history as { source: string }[];
    expect(all.filter((h) => h.source === "import")).toHaveLength(30);
    expect(all.some((h) => h.source === "tarik")).toBe(true);
    // One item's own history is complete.
    expect(((await req("admin", "GET", "/api/stock/history?code=B-5")).json.history as unknown[]).length).toBe(1);
  });
});

describe("batas query Worker (1.000 per permintaan)", () => {
  it("20.000 rows: the upload and every ACC call stay far below 1.000 queries, and the whole file lands", async () => {
    const { upload, acc, q, stats, queries } = setup();
    const rows = BULK(20000);
    const before = queries();
    const r = await upload("manager", rows);
    expect(r.status).toBe(200);
    expect(r.json.drafts).toBe(20000);
    const uploadQueries = queries() - before;
    expect(uploadQueries).toBeLessThan(150);
    expect(stats.prepares).toBeLessThan(1000); // even counting every statement of every batch

    let calls = 0;
    let worst = 0;
    let worstStatements = 0;
    for (;;) {
      const b = queries();
      const s = stats.prepares;
      const a = await acc(r.json.importId);
      worst = Math.max(worst, queries() - b);
      worstStatements = Math.max(worstStatements, stats.prepares - s);
      calls++;
      expect(a.status).toBe(200);
      if (!a.json.remaining) break;
    }
    expect(calls).toBe(Math.ceil(20000 / 120));
    expect(worst).toBeLessThan(100);
    expect(worstStatements).toBeLessThan(1000); // even counting every statement of every batch
    expect(q("SELECT COUNT(*) AS n FROM catalog_items WHERE code LIKE 'B-%'")[0].n).toBe(20000);
    expect(q("SELECT COUNT(*) AS n FROM catalog_drafts WHERE status = 'approved'")[0].n).toBe(20000);
  }, 180_000);
});

describe("unggahan yang putus", () => {
  it("a batch that fails half-way leaves no file and no drafts, and the file is never visible meanwhile", async () => {
    const { upload, q, hooks } = setup();
    let seen: unknown[] = [];
    hooks.beforeBatch = (n) => {
      if (n === 2) {
        seen = q("SELECT id FROM catalog_imports WHERE ready = 1"); // 600 rows = two write batches; the first is in
        throw new Error("batas query");
      }
    };
    const r = await upload("manager", BULK(600));
    expect(r.status).toBe(500);
    expect(q("SELECT COUNT(*) AS n FROM catalog_imports")[0].n).toBe(0);
    expect(q("SELECT COUNT(*) AS n FROM catalog_drafts")[0].n).toBe(0);
    expect(seen).toEqual([]);
  });
});
