import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { D1DatabaseShim } from "../../scripts/d1-sqlite-shim";
import { catalogRouter } from "./routes/catalog";
import { forgetCatalogIndex } from "./catalogSearchIndex";
import type { Env } from "./env";

/* Audit 10 Nov: exact-code lookup for a reopened draft, and search picks only for real codes. */

function setup() {
  forgetCatalogIndex();
  const sqlite = new DatabaseSync(":memory:");
  const dir = path.resolve(import.meta.dirname, "../../migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(path.join(dir, f), "utf8"));
  sqlite.exec(`INSERT INTO catalog_items(code, name, uom, category) VALUES
    ('100', 'ARTLINE MARKER 100', 'Pcs', 'ARTLINE'), ('100-A', 'KERTAS 100 LEMBAR', 'Pak', 'GENERAL'), ('K-1', 'Kertas', 'Rim', 'GENERAL')`);
  const app = new Hono<Env>();
  app.use(async (c, next) => {
    c.set("user", { id: 1, email: "a@x", name: "A", role: "admin" } as never);
    await next();
  });
  app.route("/api/catalog", catalogRouter);
  const env = { DB: new D1DatabaseShim(sqlite) as unknown as D1Database } as unknown as Env["Bindings"];
  const req = (p: string, init?: RequestInit) => app.request(`/api/catalog${p}`, init, env);
  return { sqlite, req };
}

describe("GET /catalog?codes=", () => {
  it("returns exactly those codes, any case, whatever a search would rank first", async () => {
    const { req } = setup();
    const r = (await (await req("?codes=100,k-1")).json()) as { items: { code: string }[]; total: number };
    expect(r.items.map((i) => i.code).sort()).toEqual(["100", "K-1"]);
    expect(r.total).toBe(2);
  });
});

describe("POST /catalog/search-picks", () => {
  it("records only codes that are in the catalog", async () => {
    const { req, sqlite } = setup();
    const res = await req("/search-picks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ q: "kertas", codes: ["K-1", "NOT-A-CODE"] }),
    });
    expect(res.status).toBe(200);
    expect(sqlite.prepare("SELECT code FROM search_picks").all()).toEqual([{ code: "K-1" }]);
  });
});
