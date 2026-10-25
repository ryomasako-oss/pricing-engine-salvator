import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { D1DatabaseShim } from "../../scripts/d1-sqlite-shim";
import { quotesRouter } from "./routes/quotes";
import type { Env } from "./env";

/* Audit P2-10 (23 Okt): this file used to test a copy of canEdit, so a broken
   check in the route itself would still pass. These go through the real routes. */

const OWNER = 1, ASSIGNEE = 2, OTHER = 3, MANAGER = 4;

function setup() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = path.resolve(import.meta.dirname, "../../migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(path.join(dir, f), "utf8"));
  sqlite.exec(`INSERT INTO users(id, email, name, password_hash, role) VALUES
    (1, 'o@x', 'Owner', 'x', 'rep'), (2, 'a@x', 'Assignee', 'x', 'rep'),
    (3, 'r@x', 'Other', 'x', 'rep'), (4, 'm@x', 'Manager', 'x', 'manager')`);
  const db = new D1DatabaseShim(sqlite) as unknown as D1Database;
  const env = { DB: db } as unknown as Env["Bindings"];
  const as = (id: number) => {
    const a = new Hono<Env>();
    a.use(async (c, next) => {
      c.set("user", { id, email: "x@x", name: "X", role: id === MANAGER ? "manager" : "rep" } as never);
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

async function draftQuote() {
  const { sqlite, as } = setup();
  const created = await as(OWNER)("POST", "/api/quotes", { title: "Izin edit" });
  expect(created.status).toBe(201);
  const id = created.json.quote.id as number;
  sqlite.prepare("UPDATE quotes SET assigned_to = ? WHERE id = ?").run(ASSIGNEE, id);
  // A rep sends only lines and terms; a manager sends the full snapshot (PE-1).
  const put = async (user: number) => {
    const { json } = await as(user)("GET", `/api/quotes/${id}`);
    const q = json.quote;
    const snapshot = user === MANAGER
      ? { assumptions: q.assumptions, items: q.items, regions: q.regions, meta: q.meta, scenario: q.scenario }
      : { items: [] };
    return as(user)("PUT", `/api/quotes/${id}`, { snapshot, expected_version: q.version });
  };
  const revision = (user: number) => as(user)("POST", `/api/quotes/${id}/revisions`, { note: "uji" });
  return { sqlite, id, put, revision };
}

describe("izin mengubah quotation, lewat route", () => {
  it("PUT: a rep who is neither creator nor assignee gets 403 and nothing changes", async () => {
    const { sqlite, id, put } = await draftQuote();
    const before = sqlite.prepare("SELECT version, items FROM quotes WHERE id = ?").get(id);
    expect((await put(OTHER)).status).toBe(403);
    expect(sqlite.prepare("SELECT version, items FROM quotes WHERE id = ?").get(id)).toEqual(before);
  });

  it("PUT: creator, assignee and manager may save", async () => {
    const { put } = await draftQuote();
    for (const user of [OWNER, ASSIGNEE, MANAGER]) expect((await put(user)).status).toBe(200);
  });

  it("POST revisions: 403 for another rep, 201 for creator, assignee and manager", async () => {
    const { sqlite, id, revision } = await draftQuote();
    expect((await revision(OTHER)).status).toBe(403);
    for (const user of [OWNER, ASSIGNEE, MANAGER]) expect((await revision(user)).status).toBe(201);
    const notes = sqlite.prepare("SELECT created_by FROM quote_revisions WHERE quote_id = ? AND note = 'uji' ORDER BY id").all(id);
    expect(notes.map((r: any) => r.created_by)).toEqual([OWNER, ASSIGNEE, MANAGER]);
  });

  it("a locked quote is 409 for the creator on both routes", async () => {
    const { sqlite, id, put, revision } = await draftQuote();
    sqlite.prepare("UPDATE quotes SET status = 'submitted' WHERE id = ?").run(id);
    expect((await put(OWNER)).status).toBe(409);
    expect((await revision(OWNER)).status).toBe(409);
  });
});
