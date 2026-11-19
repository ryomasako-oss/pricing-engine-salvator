import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { D1DatabaseShim } from "../../scripts/d1-sqlite-shim";
import { catalogRouter } from "./routes/catalog";
import { forgetCatalogIndex } from "./catalogSearchIndex";
import type { Env } from "./env";

/* 2026-11-19: Draf Perbaikan Divisi Gudang. Admin Gudang (role gudang) bekerja di Katalog seperti biasa, tetapi
   hasilnya masuk draf dan baru masuk katalog setelah di-ACC admin. */

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
  sqlite.exec(`INSERT INTO catalog_items(id, code, name, uom, cogs, list_price) VALUES (1, 'P-1', 'Pulpen', 'Pcs', 1000, 2000), (2, 'K-1', 'Kertas', 'Rim', 0, 0)`);
  sqlite.exec(`INSERT INTO catalog_item_uoms(code, uom, factor) VALUES ('P-1', 'Box', 10)`);
  let who: Who = "gudang";
  const app = new Hono<Env>();
  app.use(async (c, next) => {
    c.set("user", { id: USERS[who], email: `${who}@x`, name: who, role: who } as never);
    await next();
  });
  app.route("/api/catalog", catalogRouter);
  const env = { DB: new D1DatabaseShim(sqlite) as unknown as D1Database } as unknown as Env["Bindings"];
  const req = (as: Who, p: string, method: string, body?: unknown) => {
    who = as;
    return app.request(`/api/catalog${p}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }, env);
  };
  const q = (sql: string, ...args: (string | number)[]) => sqlite.prepare(sql).all(...args) as Record<string, unknown>[];
  const barcodeOf = (code: string, uom: string) => (q("SELECT barcode FROM catalog_unit_barcodes WHERE code = ? AND uom = ?", code, uom)[0]?.barcode as string) ?? null;
  const pending = async (as: Who = "admin") => ((await (await req(as, "/drafts", "GET")).json()) as { drafts: { id: number; kind: string }[] }).drafts;
  const review = (id: number, approve: boolean, note = "") => req("admin", `/drafts/${id}/review`, "POST", { approve, note });
  return { req, q, barcodeOf, pending, review };
}

describe("Admin Gudang: barcode", () => {
  it("lands in a draft, not the catalog, until an admin ACCs it", async () => {
    const { req, barcodeOf, pending, review, q } = setup();
    const res = await req("gudang", "/1/barcode", "PUT", { uom: "Box", barcode: "8991234567890" });
    expect(res.status).toBe(200);
    expect(barcodeOf("P-1", "Box")).toBeNull();
    const body = (await res.json()) as { drafts: { kind: string; payload: { barcode: string } }[] };
    expect(body.drafts[0]).toMatchObject({ kind: "barcode", payload: { barcode: "8991234567890" } });
    const [d] = await pending();
    expect((await review(d.id, true)).status).toBe(200);
    expect(barcodeOf("P-1", "Box")).toBe("8991234567890");
    // Applied as the admin, with the draft and the Admin Gudang named in the audit.
    const audit = q("SELECT actor_id, detail FROM audit_log WHERE action = 'barcode_set'");
    expect(audit).toHaveLength(1);
    expect(audit[0].actor_id).toBe(USERS.admin);
    expect(JSON.parse(audit[0].detail as string)).toMatchObject({ draft_id: d.id, proposed_by: USERS.gudang });
    expect(await pending()).toHaveLength(0);
  });

  it("a second save of the same SKU replaces the waiting draft", async () => {
    const { req, pending } = setup();
    await req("gudang", "/1/barcode", "PUT", { barcode: "111" });
    await req("gudang", "/1/barcode", "PUT", { barcode: "222" });
    const drafts = (await pending()) as unknown as { payload: { barcode: string } }[];
    expect(drafts).toHaveLength(1);
    expect(drafts[0].payload.barcode).toBe("222");
  });

  it("refuses a barcode another item has, or another waiting draft holds", async () => {
    const { req } = setup();
    await req("admin", "/2/barcode", "PUT", { barcode: "555" });
    expect((await req("gudang", "/1/barcode", "PUT", { barcode: "555" })).status).toBe(409);
    await req("gudang", "/1/barcode", "PUT", { barcode: "666" });
    const res = await req("gudang", "/2/barcode", "PUT", { barcode: "666" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("draf lain");
  });

  it("does not ACC a draft whose barcode went elsewhere meanwhile; it keeps waiting", async () => {
    const { req, pending, review, barcodeOf } = setup();
    await req("gudang", "/1/barcode", "PUT", { barcode: "777" });
    await req("admin", "/2/barcode", "PUT", { barcode: "777" });
    const [d] = await pending();
    expect((await review(d.id, true)).status).toBe(409);
    expect(barcodeOf("P-1", "Pcs")).toBeNull();
    expect(await pending()).toHaveLength(1);
  });

  it("Buat barcode picks the number only at ACC", async () => {
    const { req, pending, review, barcodeOf } = setup();
    await req("gudang", "/1/barcode/generate", "POST", { uom: "Pcs" });
    expect(barcodeOf("P-1", "Pcs")).toBeNull();
    await review((await pending())[0].id, true);
    expect(barcodeOf("P-1", "Pcs")).toMatch(/^20\d{11}$/);
  });
});

describe("Admin Gudang: satuan and Ubah barang", () => {
  it("a new unit is a draft, not a manager proposal; ACC adds it with its barcode", async () => {
    const { req, q, pending, review, barcodeOf } = setup();
    expect((await req("gudang", "/1/unit", "POST", { uom: "Dus", factor: 100, barcode: "999" })).status).toBe(201);
    expect(q("SELECT * FROM catalog_unit_proposals")).toHaveLength(0);
    expect(q("SELECT * FROM catalog_item_uoms WHERE uom = 'Dus'")).toHaveLength(0);
    expect(barcodeOf("P-1", "Dus")).toBeNull();
    await review((await pending())[0].id, true);
    expect(q("SELECT factor FROM catalog_item_uoms WHERE code = 'P-1' AND uom = 'Dus'")[0].factor).toBe(100);
    expect(barcodeOf("P-1", "Dus")).toBe("999");
  });

  it("Ubah barang changes units and name through a draft, and never touches cost or price", async () => {
    const { req, q, pending, review } = setup();
    const res = await req("gudang", "/1", "PUT", {
      name: "Pulpen Biru", uom: "Pcs", category: "", cogs: 1, list_price: 1, units: [{ uom: "Box", factor: 12 }],
    });
    expect(res.status).toBe(200);
    expect(q("SELECT name FROM catalog_items WHERE id = 1")[0].name).toBe("Pulpen");
    expect(q("SELECT factor FROM catalog_item_uoms WHERE code = 'P-1' AND uom = 'Box'")[0].factor).toBe(10);
    const [d] = (await pending()) as unknown as { id: number; payload: Record<string, unknown> }[];
    expect(d.payload).not.toHaveProperty("cogs");
    await review(d.id, true);
    expect(q("SELECT name, cogs, list_price FROM catalog_items WHERE id = 1")[0]).toEqual({ name: "Pulpen Biru", cogs: 1000, list_price: 2000 });
    expect(q("SELECT factor FROM catalog_item_uoms WHERE code = 'P-1' AND uom = 'Box'")[0].factor).toBe(12);
  });

  it("an older Ubah barang draft does not undo a unit ACCed after it was drafted", async () => {
    const { req, q, pending, review } = setup();
    await req("gudang", "/1", "PUT", { name: "Pulpen", uom: "Pcs", category: "", units: [{ uom: "Box", factor: 12 }] });
    await req("gudang", "/1/unit", "POST", { uom: "Dus", factor: 100 });
    const drafts = await pending();
    await review(drafts.find((d) => d.kind === "unit")!.id, true);
    await review(drafts.find((d) => d.kind === "edit")!.id, true);
    expect(q("SELECT uom, factor FROM catalog_item_uoms WHERE code = 'P-1' ORDER BY factor")).toEqual([
      { uom: "Box", factor: 12 },
      { uom: "Dus", factor: 100 },
    ]);
  });

  it("an edit that changes nothing is not saved as a draft", async () => {
    const { req, pending } = setup();
    const res = await req("gudang", "/1", "PUT", { name: "Pulpen", uom: "Pcs", category: "", units: [{ uom: "Box", factor: 10 }] });
    expect(res.status).toBe(400);
    expect(await pending()).toHaveLength(0);
  });
});

describe("who may see, ACC, reject, cancel", () => {
  it("only an admin ACCs; a manager cannot", async () => {
    const { req, pending } = setup();
    await req("gudang", "/1/barcode", "PUT", { barcode: "123" });
    const [d] = await pending();
    expect((await req("manager", `/drafts/${d.id}/review`, "POST", { approve: true })).status).toBe(403);
    expect((await req("gudang", `/drafts/${d.id}/review`, "POST", { approve: true })).status).toBe(403);
    expect((await req("manager", "/drafts", "GET")).status).toBe(403);
  });

  it("a rejection needs a reason, and leaves the catalog as it was", async () => {
    const { req, pending, review, barcodeOf, q } = setup();
    await req("gudang", "/1/barcode", "PUT", { barcode: "123" });
    const [d] = await pending();
    expect((await review(d.id, false)).status).toBe(400);
    expect((await review(d.id, false, "Barcode salah kemasan")).status).toBe(200);
    expect(barcodeOf("P-1", "Pcs")).toBeNull();
    expect(q("SELECT status, note FROM catalog_drafts")[0]).toEqual({ status: "rejected", note: "Barcode salah kemasan" });
    expect((await review(d.id, true)).status).toBe(409);
  });

  it("the Admin Gudang sees and cancels only their own drafts", async () => {
    const { req, pending } = setup();
    await req("gudang", "/1/barcode", "PUT", { barcode: "123" });
    const [d] = await pending("gudang");
    expect((await req("admin", `/drafts/${d.id}/cancel`, "POST")).status).toBe(404);
    expect((await req("gudang", `/drafts/${d.id}/cancel`, "POST")).status).toBe(200);
    expect(await pending("gudang")).toHaveLength(0);
  });

  it("other roles keep saving directly, as before", async () => {
    const { req, barcodeOf, q } = setup();
    await req("rep", "/1/barcode", "PUT", { barcode: "321" });
    expect(barcodeOf("P-1", "Pcs")).toBe("321");
    await req("rep", "/1/unit", "POST", { uom: "Dus", factor: 100 });
    expect(q("SELECT uom FROM catalog_unit_proposals")).toHaveLength(1);
    expect(q("SELECT * FROM catalog_drafts")).toHaveLength(0);
  });
});
