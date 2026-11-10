import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { D1DatabaseShim } from "../../scripts/d1-sqlite-shim";
import { quotesRouter } from "./routes/quotes";
import type { Env } from "./env";

/* GET /quotes marks each row `mine` (made by or reassigned to the viewer), so a
   rep's dashboard counts only their own work even with "Punya saya" off. */

const REP = 1, OTHER = 2;

function setup() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = path.resolve(import.meta.dirname, "../../migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(path.join(dir, f), "utf8"));
  sqlite.exec(`INSERT INTO users(id, email, name, password_hash, role) VALUES (1, 'r@x', 'Rep', 'x', 'rep'), (2, 'o@x', 'Other', 'x', 'rep')`);
  const env = { DB: new D1DatabaseShim(sqlite) as unknown as D1Database } as unknown as Env["Bindings"];
  const as = (id: number) => {
    const a = new Hono<Env>();
    a.use(async (c, next) => {
      c.set("user", { id, email: "x@x", name: "X", role: "rep" } as never);
      await next();
    });
    a.route("/api/quotes", quotesRouter);
    return async (method: string, p: string, body?: unknown) => {
      const r = await a.request(p, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json" } }, env);
      return { status: r.status, json: (await r.json()) as Record<string, any> };
    };
  };
  return { sqlite, as };
}

describe("GET /quotes mine flag", () => {
  it("is true for the viewer's own and reassigned quotes, false for a colleague's", async () => {
    const t = setup();
    const own = (await t.as(REP)("POST", "/api/quotes", { title: "Punya rep" })).json.quote.id as number;
    const theirs = (await t.as(OTHER)("POST", "/api/quotes", { title: "Punya rekan" })).json.quote.id as number;
    const handed = (await t.as(OTHER)("POST", "/api/quotes", { title: "Dialihkan ke rep" })).json.quote.id as number;
    t.sqlite.prepare("UPDATE quotes SET assigned_to = ? WHERE id = ?").run(REP, handed);

    const list = await t.as(REP)("GET", "/api/quotes");
    expect(list.status).toBe(200);
    const mine = Object.fromEntries((list.json.quotes as { id: number; mine: boolean }[]).map((q) => [q.id, q.mine]));
    expect(mine).toEqual({ [own]: true, [theirs]: false, [handed]: true });
  });
});
