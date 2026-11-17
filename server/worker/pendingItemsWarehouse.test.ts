import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { D1DatabaseShim } from "../../scripts/d1-sqlite-shim";
import { pendingItemsRouter } from "./routes/pendingItems";
import type { Env } from "./env";

/* 2026-11-17: barang baru dari gudang, dengan satuan tambahan dan barcode per satuan (tahap 2). */

function setup(role: "rep" | "manager" = "rep") {
  const sqlite = new DatabaseSync(":memory:");
  const dir = path.resolve(import.meta.dirname, "../../migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(path.join(dir, f), "utf8"));
  sqlite.exec(`INSERT INTO users(id, email, name, password_hash, role) VALUES (1, 'a@x', 'A', 'x', '${role}')`);
  sqlite.exec(`INSERT INTO catalog_items(id, code, name, uom) VALUES (1, 'P-1', 'Pulpen', 'Pcs')`);
  sqlite.exec(`INSERT INTO catalog_unit_barcodes(code, uom, barcode) VALUES ('P-1', 'Pcs', '111')`);
  const app = new Hono<Env>();
  app.use(async (c, next) => {
    c.set("user", { id: 1, email: "a@x", name: "A", role } as never);
    await next();
  });
  app.route("/api/pending-items", pendingItemsRouter);
  const env = { DB: new D1DatabaseShim(sqlite) as unknown as D1Database } as unknown as Env["Bindings"];
  const req = async (method: string, url: string, body?: unknown) => {
    const r = await app.request(`/api/pending-items${url}`, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }, env);
    return { status: r.status, json: (await r.json()) as Record<string, any> };
  };
  const rows = (sql: string) => sqlite.prepare(sql).all();
  return { sqlite, req, rows };
}

const marker = { name: "Spidol Artline EK-6666 Hijau", uom: "Pcs", units: [{ uom: "Box", factor: 12 }], barcodes: [{ uom: "pcs", barcode: "8990001" }, { uom: "Box", generate: true }] };

describe("barang baru dari gudang", () => {
  it("keeps the units as proposals and the barcodes under the requested code", async () => {
    const { req, rows } = setup("rep");
    const r = await req("POST", "", marker);
    expect(r.status).toBe(201);
    expect(r.json.item.code).toBe("BARU-0001");
    expect(rows("SELECT code, uom, factor FROM catalog_unit_proposals")).toEqual([{ code: "BARU-0001", uom: "Box", factor: 12 }]);
    expect(rows("SELECT code, uom, barcode, generated FROM catalog_unit_barcodes WHERE code = 'BARU-0001' ORDER BY uom")).toEqual([
      { code: "BARU-0001", uom: "Box", barcode: "2000000000015", generated: 1 },
      { code: "BARU-0001", uom: "Pcs", barcode: "8990001", generated: 0 },
    ]);
    const list = await req("GET", "");
    expect(list.json.items[0].barcodes).toHaveLength(2);
    expect(list.json.items[0].units).toEqual([{ uom: "Box", factor: 12 }]);
  });

  it("refuses a barcode another item already has, and writes nothing", async () => {
    const { req, rows } = setup("rep");
    const r = await req("POST", "", { ...marker, barcodes: [{ uom: "Pcs", barcode: "111" }] });
    expect(r.status).toBe(409);
    expect(r.json.error).toContain("P-1 Pulpen");
    expect(rows("SELECT id FROM pending_items")).toEqual([]);
  });

  it("refuses a barcode for a unit the request does not have, or a unit named twice", async () => {
    const { req } = setup("rep");
    expect((await req("POST", "", { ...marker, barcodes: [{ uom: "Dus", barcode: "5" }] })).status).toBe(400);
    expect((await req("POST", "", { ...marker, units: [{ uom: "Box", factor: 12 }, { uom: "box", factor: 10 }] })).status).toBe(400);
  });

  it("asking again for the same name with barcodes points to the live request instead of hiding them on it", async () => {
    const { req } = setup("rep");
    await req("POST", "", { name: marker.name, uom: "Pcs" });
    const again = await req("POST", "", marker);
    expect(again.status).toBe(409);
    expect(again.json.error).toContain("BARU-0001");
  });

  it("the barcodes reach the catalog item when it arrives with the same code", async () => {
    const { req, sqlite, rows } = setup("manager");
    await req("POST", "", { ...marker, code: "80801999" });
    sqlite.exec(`INSERT INTO catalog_items(code, name, uom) VALUES ('80801999', 'ARTLINE EK-6666 GREEN', 'Pcs')`);
    await req("GET", "");
    expect(rows("SELECT status FROM pending_items")).toEqual([{ status: "linked" }]);
    expect(rows("SELECT uom FROM catalog_unit_barcodes WHERE code = '80801999' ORDER BY uom")).toEqual([{ uom: "Box" }, { uom: "Pcs" }]);
  });

  it("a manager links it to another Accurate code: barcodes and units move, the catalog's own barcode wins", async () => {
    const { req, sqlite, rows } = setup("manager");
    const made = await req("POST", "", { ...marker, units: [{ uom: "Box", factor: 12 }, { uom: "Dus", factor: 48 }] });
    sqlite.exec(`INSERT INTO catalog_items(code, name, uom) VALUES ('80801999', 'ARTLINE EK-6666 GREEN', 'PCS')`);
    sqlite.exec(`INSERT INTO catalog_item_uoms(code, uom, factor) VALUES ('80801999', 'Dus', 50)`);
    sqlite.exec(`INSERT INTO catalog_unit_barcodes(code, uom, barcode) VALUES ('80801999', 'PCS', '8995555')`);
    expect((await req("POST", `/${made.json.item.id}/link`, { code: "nope" })).status).toBe(404);
    const r = await req("POST", `/${made.json.item.id}/link`, { code: " 80801999 " });
    expect(r.status).toBe(200);
    expect(r.json.item).toMatchObject({ status: "linked", linked_code: "80801999" });
    expect(r.json.dropped).toEqual([{ uom: "Pcs", barcode: "8990001" }]);
    expect(rows("SELECT uom, barcode FROM catalog_unit_barcodes WHERE code = '80801999' ORDER BY uom")).toEqual([
      { uom: "Box", barcode: "2000000000015" },
      { uom: "PCS", barcode: "8995555" },
    ]);
    // Box is new to the item: it waits for approval there. Dus already has Accurate's ratio: dropped.
    expect(rows("SELECT code, uom FROM catalog_unit_proposals")).toEqual([{ code: "80801999", uom: "Box" }]);
    expect(rows("SELECT COUNT(*) AS n FROM catalog_unit_barcodes WHERE code = 'BARU-0001'")).toEqual([{ n: 0 }]);
    expect((await req("POST", `/${made.json.item.id}/link`, { code: "80801999" })).status).toBe(409);
  });

  it("a cancelled request frees its barcodes", async () => {
    const { req, rows } = setup("manager");
    const made = await req("POST", "", marker);
    expect((await req("POST", `/${made.json.item.id}/cancel`)).status).toBe(200);
    expect(rows("SELECT COUNT(*) AS n FROM catalog_unit_barcodes WHERE code = 'BARU-0001'")).toEqual([{ n: 0 }]);
    expect(rows("SELECT COUNT(*) AS n FROM catalog_unit_proposals")).toEqual([{ n: 0 }]);
  });

  it("a rep cannot link a request", async () => {
    const { req } = setup("rep");
    const made = await req("POST", "", marker);
    expect((await req("POST", `/${made.json.item.id}/link`, { code: "P-1" })).status).toBe(403);
  });
});
