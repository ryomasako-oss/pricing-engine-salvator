import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { D1DatabaseShim } from "../../scripts/d1-sqlite-shim";
import { quotesRouter } from "./routes/quotes";
import type { Env } from "./env";

/*
 * Workers Free plan: 50 D1 queries per invocation, each statement counted
 * (also inside a batch). Review of PR #23: looking pending "barang baru"
 * codes up next to every catalog lookup took a rep's preview of a 300-code
 * quote from 33 statements to 53, over the limit, so such quotes would stop
 * working in production. Pending codes are looked up only for codes the
 * catalog doesn't have, so a quote of catalog items costs what it did.
 */

const CODES = 300;

function freshDb() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = path.resolve(import.meta.dirname, "../../migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(path.join(dir, f), "utf8"));
  sqlite.exec(`INSERT INTO users(id, email, name, password_hash, role) VALUES (2, 'r@x', 'R', 'x', 'rep')`);
  const add = sqlite.prepare("INSERT INTO catalog_items(code, name, uom, cogs, list_price) VALUES (?, ?, 'Pcs', 1000, 2000)");
  for (let i = 0; i < CODES; i++) add.run(`K-${i}`, `Barang ${i}`);
  // Count what reaches SQLite: every D1 statement the shim runs prepares once.
  let executed = 0;
  const prepare = sqlite.prepare.bind(sqlite);
  sqlite.prepare = ((sql: string) => {
    executed++;
    return prepare(sql);
  }) as typeof sqlite.prepare;
  const db = new D1DatabaseShim(sqlite) as unknown as D1Database;
  return { db, count: () => executed, reset: () => void (executed = 0) };
}

function asRep(db: D1Database) {
  const app = new Hono<Env>();
  app.use(async (c, next) => {
    c.set("user", { id: 2, email: "r@x", name: "R", role: "rep" } as never);
    await next();
  });
  app.route("/api/quotes", quotesRouter);
  const env = { DB: db } as unknown as Env["Bindings"];
  const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
  return async (method: string, url: string, body?: unknown) => {
    const r = await app.request(url, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }, env, ctx);
    return { status: r.status, json: (await r.json()) as Record<string, any> };
  };
}

const lines = Array.from({ length: CODES }, (_, i) => ({ id: `l${i}`, code: `K-${i}`, qty: 1, rrp: 2000 }));

describe(`D1 statements for a rep's ${CODES}-code quote (Workers Free plan: 50)`, () => {
  it("previewing and opening it stay as cheap as before barang baru", async () => {
    const { db, count, reset } = freshDb();
    const api = asRep(db);
    const made = await api("POST", "/api/quotes", { title: "Besar", snapshot: { items: lines } });
    expect(made.status).toBe(201);
    const id = made.json.quote.id;

    reset();
    const preview = await api("POST", "/api/quotes/preview", { quote_id: id, snapshot: { items: lines } });
    const previewStatements = count();
    reset();
    const opened = await api("GET", `/api/quotes/${id}`);
    const openStatements = count();

    expect(preview.status).toBe(200);
    expect(opened.status).toBe(200);
    // The base branch (before barang baru) measured 33 and 17 here.
    expect({ previewStatements, openStatements }).toEqual({ previewStatements: 33, openStatements: 17 });
  });
});
