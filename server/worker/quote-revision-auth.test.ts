import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { D1DatabaseShim } from "../../scripts/d1-sqlite-shim";
import { quotesRouter } from "./routes/quotes";
import type { Env } from "./env";

/* POST /quotes/:id/revisions re-checks status and ownership inside its INSERT,
   so a lock or reassignment landing between the route's read and its write
   can't slip a revision in. This file used to run that SQL by hand; these go
   through the real route, with the competing write landing right before the INSERT. */

const OWNER = 1, ASSIGNEE = 2, OTHER = 3;

function setup() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = path.resolve(import.meta.dirname, "../../migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(path.join(dir, f), "utf8"));
  sqlite.exec(`INSERT INTO users(id, email, name, password_hash, role) VALUES
    (1, 'o@x', 'Owner', 'x', 'rep'), (2, 'a@x', 'Assignee', 'x', 'rep'), (3, 'r@x', 'Other', 'x', 'rep')`);
  const shim = new D1DatabaseShim(sqlite);
  // Runs once, just before the route's revision INSERT.
  let before: (() => void) | undefined;
  const db = new Proxy(shim, {
    get(target, prop) {
      if (prop !== "prepare") return Reflect.get(target, prop);
      return (sql: string) => {
        if (before && sql.trimStart().startsWith("INSERT INTO quote_revisions")) {
          before();
          before = undefined;
        }
        return target.prepare(sql);
      };
    },
  }) as unknown as D1Database;
  const env = { DB: db } as unknown as Env["Bindings"];
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
  return { sqlite, as, raceBeforeInsert: (fn: () => void) => { before = fn; } };
}

async function draftQuote() {
  const t = setup();
  const created = await t.as(OWNER)("POST", "/api/quotes", { title: "Race" });
  expect(created.status).toBe(201);
  const id = created.json.quote.id as number;
  const revisions = () => (t.sqlite.prepare("SELECT COUNT(*) AS n FROM quote_revisions WHERE quote_id = ? AND note = 'race'").get(id) as { n: number }).n;
  return { ...t, id, revisions };
}

describe("POST /quotes/:id/revisions under a concurrent change", () => {
  it("a lock between the read and the INSERT gives 409 and no revision", async () => {
    const { sqlite, as, raceBeforeInsert, id, revisions } = await draftQuote();
    raceBeforeInsert(() => sqlite.prepare("UPDATE quotes SET status = 'submitted' WHERE id = ?").run(id));
    expect((await as(OWNER)("POST", `/api/quotes/${id}/revisions`, { note: "race" })).status).toBe(409);
    expect(revisions()).toBe(0);
  });

  it("losing the assignment between the read and the INSERT gives 403 and no revision", async () => {
    const { sqlite, as, raceBeforeInsert, id, revisions } = await draftQuote();
    sqlite.prepare("UPDATE quotes SET assigned_to = ? WHERE id = ?").run(ASSIGNEE, id);
    raceBeforeInsert(() => sqlite.prepare("UPDATE quotes SET assigned_to = ? WHERE id = ?").run(OTHER, id));
    expect((await as(ASSIGNEE)("POST", `/api/quotes/${id}/revisions`, { note: "race" })).status).toBe(403);
    expect(revisions()).toBe(0);
  });

  it("without a race the owner saves exactly one revision", async () => {
    const { as, id, revisions } = await draftQuote();
    expect((await as(OWNER)("POST", `/api/quotes/${id}/revisions`, { note: "race" })).status).toBe(201);
    expect(revisions()).toBe(1);
  });
});
