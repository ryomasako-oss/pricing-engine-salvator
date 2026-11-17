import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { D1DatabaseShim } from "../../scripts/d1-sqlite-shim";
import { catalogRouter } from "./routes/catalog";
import { forgetCatalogIndex } from "./catalogSearchIndex";
import type { Env } from "./env";

/* 2026-11-17: barcode per satuan (SKU), diisi orang gudang (akun rep) dari kemasan barang. */

function setup(role: "rep" | "manager" | "admin" = "rep") {
  forgetCatalogIndex();
  const sqlite = new DatabaseSync(":memory:");
  const dir = path.resolve(import.meta.dirname, "../../migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(path.join(dir, f), "utf8"));
  sqlite.exec(`INSERT INTO users(id, email, name, role, password_hash) VALUES (1, 'a@x', 'A', '${role}', 'x')`);
  sqlite.exec(`INSERT INTO catalog_items(id, code, name, uom) VALUES (1, 'P-1', 'Pulpen', 'Pcs'), (2, 'K-1', 'Kertas', 'Rim')`);
  const app = new Hono<Env>();
  app.use(async (c, next) => {
    c.set("user", { id: 1, email: "a@x", name: "A", role } as never);
    await next();
  });
  app.route("/api/catalog", catalogRouter);
  const env = { DB: new D1DatabaseShim(sqlite) as unknown as D1Database } as unknown as Env["Bindings"];
  const req = (p: string, method: string, body: unknown) =>
    app.request(`/api/catalog${p}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, env);
  const barcodeOf = (id: number, uom?: string) =>
    (
      sqlite
        .prepare(
          `SELECT b.barcode AS b FROM catalog_unit_barcodes b JOIN catalog_items i ON i.code = b.code
            WHERE i.id = ? AND b.uom = COALESCE(?, i.uom)`,
        )
        .get(id, uom ?? null) as { b: string } | undefined
    )?.b ?? null;
  return { sqlite, req, barcodeOf };
}

describe("PUT /catalog/:id/barcode", () => {
  it("lets a rep (warehouse) set it, and records who did", async () => {
    const { req, barcodeOf, sqlite } = setup("rep");
    const res = await req("/1/barcode", "PUT", { barcode: " 8991234567890 " });
    expect(res.status).toBe(200);
    expect(barcodeOf(1)).toBe("8991234567890");
    expect(sqlite.prepare("SELECT action FROM audit_log WHERE action = 'barcode_set'").all()).toHaveLength(1);
  });

  it("refuses a barcode already on another item, naming that item", async () => {
    const { req, barcodeOf } = setup();
    await req("/1/barcode", "PUT", { barcode: "8991234567890" });
    const res = await req("/2/barcode", "PUT", { barcode: "8991234567890" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain("P-1");
    expect(barcodeOf(2)).toBeNull();
  });

  it("never clears a saved barcode by an emptied box: only an explicit delete clears it", async () => {
    const { req, barcodeOf } = setup();
    await req("/1/barcode", "PUT", { barcode: "123" });
    const emptied = await req("/1/barcode", "PUT", { barcode: "" });
    expect(emptied.status).toBe(400);
    // Names the button as it is labelled in Katalog.
    expect(((await emptied.json()) as { error: string }).error).toContain("tombol Hapus barcode");
    expect(barcodeOf(1)).toBe("123");
    expect((await req("/1/barcode", "PUT", { barcode: "", clear: true })).status).toBe(200);
    expect(barcodeOf(1)).toBeNull();
  });

  it("rejects odd characters and unknown items", async () => {
    const { req } = setup();
    expect((await req("/1/barcode", "PUT", { barcode: "12 34'" })).status).toBe(400);
    expect((await req("/99/barcode", "PUT", { barcode: "1" })).status).toBe(404);
  });

  it("survives a catalog import (merge) of the same item", async () => {
    const { req, barcodeOf } = setup("admin");
    await req("/1/barcode", "PUT", { barcode: "555" });
    const imp = await req("/import", "POST", { rows: [{ code: "P-1", name: "Pulpen Biru" }], source: "test" });
    expect(imp.status).toBe(200);
    expect(barcodeOf(1)).toBe("555");
  });
});

describe("barcode per unit (SKU)", () => {
  it("gives each unit of an item its own barcode, and refuses a unit the item does not have", async () => {
    const { req, barcodeOf, sqlite } = setup();
    sqlite.exec(`INSERT INTO catalog_item_uoms(code, uom, factor) VALUES ('P-1', 'Box', 12)`);
    expect((await req("/1/barcode", "PUT", { barcode: "111" })).status).toBe(200);
    const box = await req("/1/barcode", "PUT", { uom: "box", barcode: "222" });
    expect(box.status).toBe(200);
    expect(((await box.json()) as { barcodes: { uom: string; barcode: string }[] }).barcodes.map((b) => b.barcode)).toEqual(["111", "222"]);
    expect(barcodeOf(1, "Box")).toBe("222");
    const dus = await req("/1/barcode", "PUT", { uom: "Dus", barcode: "333" });
    expect(dus.status).toBe(400);
    expect(((await dus.json()) as { error: string }).error).toContain("Tambah satuannya dulu");
  });

  it("refuses a barcode already on another unit of the same item, naming the unit", async () => {
    const { req, sqlite } = setup();
    sqlite.exec(`INSERT INTO catalog_item_uoms(code, uom, factor) VALUES ('P-1', 'Box', 12)`);
    await req("/1/barcode", "PUT", { barcode: "111" });
    const res = await req("/1/barcode", "PUT", { uom: "Box", barcode: "111" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("Barcode 111 sudah dipakai barang P-1 Pulpen (Pcs).");
  });

  it("generates valid internal EAN-13s (prefix 20), one after another, skipping a number typed in by hand", async () => {
    const { req, barcodeOf, sqlite } = setup();
    sqlite.exec(`INSERT INTO catalog_item_uoms(code, uom, factor) VALUES ('P-1', 'Box', 12)`);
    const first = await req("/1/barcode/generate", "POST", {});
    expect(first.status).toBe(200);
    expect(barcodeOf(1)).toBe("2000000000015");
    // The next number is already on another item (a brand barcode typed in by hand).
    await req("/2/barcode", "PUT", { barcode: "2000000000022" });
    await req("/1/barcode/generate", "POST", { uom: "Box" });
    expect(barcodeOf(1, "Box")).toBe("2000000000039");
    expect((await req("/1/barcode/generate", "POST", {})).status).toBe(409);
  });

  it("keeps the brand barcodes filled in before units had their own (migration 0039)", () => {
    const sqlite = new DatabaseSync(":memory:");
    const dir = path.resolve(import.meta.dirname, "../../migrations");
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    for (const f of files.filter((f) => f < "0039")) sqlite.exec(readFileSync(path.join(dir, f), "utf8"));
    sqlite.exec(`INSERT INTO catalog_items(code, name, uom, supplier_barcode) VALUES ('P-1', 'Pulpen', 'Pcs', '899'), ('K-1', 'Kertas', 'Rim', NULL)`);
    for (const f of files.filter((f) => f >= "0039")) sqlite.exec(readFileSync(path.join(dir, f), "utf8"));
    expect(sqlite.prepare("SELECT code, uom, barcode, generated FROM catalog_unit_barcodes").all()).toEqual([
      { code: "P-1", uom: "Pcs", barcode: "899", generated: 0 },
    ]);
  });
});

describe("unit proposed by warehouse staff", () => {
  const unitsOf = (sqlite: DatabaseSync) => sqlite.prepare("SELECT uom, factor, manual FROM catalog_item_uoms WHERE code = 'K-1'").all();

  it("is held for a manager: quotes keep Accurate's units until it is approved", async () => {
    const { req, sqlite, barcodeOf } = setup("rep");
    const res = await req("/2/unit", "POST", { uom: "lembar", factor: 1 / 500, barcode: "777" });
    expect(res.status).toBe(201);
    expect(unitsOf(sqlite)).toEqual([]);
    expect(sqlite.prepare("SELECT uom, factor FROM catalog_unit_proposals").all()).toEqual([{ uom: "lembar", factor: 1 / 500 }]);
    // Its barcode is kept already, so the label can be printed.
    expect(barcodeOf(2, "lembar")).toBe("777");
    // A new unit name joins the list.
    expect(sqlite.prepare("SELECT name FROM uom_options WHERE name = 'lembar'").all()).toHaveLength(1);
    // A rep cannot approve it.
    expect((await req("/2/unit/review", "POST", { uom: "lembar", approve: true })).status).toBe(403);
  });

  it("refuses a unit the item already has, or one already proposed", async () => {
    const { req } = setup("rep");
    expect((await req("/2/unit", "POST", { uom: "rim", factor: 1 })).status).toBe(409);
    await req("/2/unit", "POST", { uom: "Box", factor: 5 });
    const again = await req("/2/unit", "POST", { uom: "box", factor: 6 });
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: string }).error).toContain("menunggu persetujuan");
  });

  it("uses the list's spelling of a known unit name, and can generate its barcode", async () => {
    const { req, sqlite } = setup("rep");
    await req("/2/unit", "POST", { uom: "box", factor: 5, generate: true });
    expect(sqlite.prepare("SELECT uom FROM catalog_unit_proposals").get()).toEqual({ uom: "Box" });
    expect(sqlite.prepare("SELECT barcode, generated FROM catalog_unit_barcodes WHERE uom = 'Box'").get()).toEqual({ barcode: "2000000000015", generated: 1 });
  });

  it("added by a manager needs no review: quotes use it at once, marked manual", async () => {
    const { req, sqlite } = setup("manager");
    expect((await req("/2/unit", "POST", { uom: "Dus", factor: 50 })).status).toBe(201);
    expect(unitsOf(sqlite)).toEqual([{ uom: "Dus", factor: 50, manual: 1 }]);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM catalog_unit_proposals").get()).toEqual({ n: 0 });
  });

  it("review: approve moves it into the units; reject drops it and its barcode", async () => {
    const { req, sqlite } = setup("manager");
    sqlite.exec(`INSERT INTO catalog_unit_proposals(code, uom, factor, proposed_by) VALUES ('K-1', 'Box', 5, 1), ('K-1', 'Dus', 50, 1)`);
    sqlite.exec(`INSERT INTO catalog_unit_barcodes(code, uom, barcode) VALUES ('K-1', 'Box', '555'), ('K-1', 'Dus', '666')`);
    const list = (await (await req("/unit-proposals", "GET", undefined)).json()) as { proposals: { uom: string; barcode: string }[] };
    expect(list.proposals.map((p) => [p.uom, p.barcode])).toEqual([["Box", "555"], ["Dus", "666"]]);
    expect((await req("/2/unit/review", "POST", { uom: "box", approve: true })).status).toBe(200);
    expect((await req("/2/unit/review", "POST", { uom: "Dus", approve: false })).status).toBe(200);
    expect(unitsOf(sqlite)).toEqual([{ uom: "Box", factor: 5, manual: 1 }]);
    expect(sqlite.prepare("SELECT uom, barcode FROM catalog_unit_barcodes").all()).toEqual([{ uom: "Box", barcode: "555" }]);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM catalog_unit_proposals").get()).toEqual({ n: 0 });
    expect((await req("/2/unit/review", "POST", { uom: "Dus", approve: true })).status).toBe(404);
  });

  it("Edit barang keeps the manual mark of a unit that stays", async () => {
    const { req, sqlite } = setup("admin");
    sqlite.exec(`INSERT INTO catalog_item_uoms(code, uom, factor, manual) VALUES ('K-1', 'Box', 5, 0), ('K-1', 'Pak', 2, 1)`);
    const res = await req("/2", "PUT", { name: "Kertas", uom: "Rim", cogs: 0, list_price: 0, units: [{ uom: "Box", factor: 6 }, { uom: "Pak", factor: 2 }, { uom: "Dus", factor: 50 }] });
    expect(res.status).toBe(200);
    expect(sqlite.prepare("SELECT uom, factor, manual FROM catalog_item_uoms WHERE code = 'K-1' ORDER BY factor").all()).toEqual([
      { uom: "Pak", factor: 2, manual: 1 },
      { uom: "Box", factor: 6, manual: 0 },
      { uom: "Dus", factor: 50, manual: 1 },
    ]);
  });
});
