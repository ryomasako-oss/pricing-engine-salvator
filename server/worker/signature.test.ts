import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { D1DatabaseShim } from "../../scripts/d1-sqlite-shim";
import { authRouter } from "./routes/auth";
import { quotesRouter } from "./routes/quotes";
import type { Env } from "./env";

/* Signature per user for the quotation letter (2026-11-19): each user sets only
   their own, and a quote hands out its creator's only once it is final, so a
   draft can never be printed signed. */

const PNG = "data:image/png;base64,iVBORw0KGgo=";

function setup() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = path.resolve(import.meta.dirname, "../../migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(path.join(dir, f), "utf8"));
  sqlite.exec(`INSERT INTO users(email, name, password_hash, role) VALUES('e@x', 'Ernita', 'x', 'manager'), ('r@x', 'Rina', 'x', 'rep');
    INSERT INTO quotes(number, status, assumptions, items, regions, meta, created_by) VALUES
      ('Q-1', 'draft', '{}', '[]', '[]', '{}', 1), ('Q-2', 'approved', '{}', '[]', '[]', '{}', 1);`);
  const env = { DB: new D1DatabaseShim(sqlite) as unknown as D1Database } as unknown as Env["Bindings"];
  let as = { id: 1, email: "e@x", name: "Ernita", role: "manager" };
  const a = new Hono<Env>();
  a.use(async (c, next) => { c.set("user", as as never); await next(); });
  a.route("/api/auth", authRouter);
  a.route("/api/quotes", quotesRouter);
  const call = async (method: string, url: string, body?: unknown) => {
    const r = await a.request(url, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json" } }, env);
    return { status: r.status, json: (await r.json()) as Record<string, any> };
  };
  const stored = (id: number) => (sqlite.prepare("SELECT signature FROM users WHERE id = ?").get(id) as { signature: string }).signature;
  return { call, stored, login: (u: typeof as) => { as = u; } };
}

describe("signature per user", () => {
  it("a user sets and removes only their own signature", async () => {
    const t = setup();
    expect((await t.call("PUT", "/api/auth/signature", { signature: PNG })).status).toBe(200);
    expect(t.stored(1)).toBe(PNG);
    expect(t.stored(2)).toBe("");
    expect((await t.call("GET", "/api/auth/signature")).json.signature).toBe(PNG);
    await t.call("PUT", "/api/auth/signature", { signature: "" });
    expect(t.stored(1)).toBe("");
  });

  it("rejects anything but a PNG/JPEG/WEBP data URL, and an oversized one", async () => {
    const t = setup();
    for (const bad of ["https://x/y.png", "data:image/svg+xml;base64,PHN2Zz4=", "data:image/png;base64,<script>", `data:image/png;base64,${"A".repeat(400_001)}`]) {
      const r = await t.call("PUT", "/api/auth/signature", { signature: bad });
      expect(r.status, bad.slice(0, 30)).toBe(400);
    }
    expect(t.stored(1)).toBe("");
  });

  it("a quote gives its creator's signature only once it is final", async () => {
    const t = setup();
    await t.call("PUT", "/api/auth/signature", { signature: PNG });
    t.login({ id: 2, email: "r@x", name: "Rina", role: "rep" });
    expect((await t.call("GET", "/api/quotes/1/signature")).json).toEqual({ name: "Ernita", signature: "" });
    expect((await t.call("GET", "/api/quotes/2/signature")).json).toEqual({ name: "Ernita", signature: PNG });
    expect((await t.call("GET", "/api/quotes/99/signature")).status).toBe(404);
  });
});
