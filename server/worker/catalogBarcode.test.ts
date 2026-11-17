import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { D1DatabaseShim } from "../../scripts/d1-sqlite-shim";
import { catalogRouter } from "./routes/catalog";
import { forgetCatalogIndex } from "./catalogSearchIndex";
import type { Env } from "./env";

/* 2026-11-17: barcode supplier, diisi orang gudang (akun rep) dari kemasan barang. */

function setup(role: "rep" | "admin" = "rep") {
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
  const barcodeOf = (id: number) =>
    (sqlite.prepare("SELECT supplier_barcode AS b FROM catalog_items WHERE id = ?").get(id) as { b: string | null }).b;
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

  it("clears it with an empty value and rejects odd characters", async () => {
    const { req, barcodeOf } = setup();
    await req("/1/barcode", "PUT", { barcode: "123" });
    expect((await req("/1/barcode", "PUT", { barcode: "" })).status).toBe(200);
    expect(barcodeOf(1)).toBeNull();
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
