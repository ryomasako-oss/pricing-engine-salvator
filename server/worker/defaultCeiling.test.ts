import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { D1DatabaseShim } from "../../scripts/d1-sqlite-shim";
import { DEFAULT_ASSUMPTIONS } from "../../shared/engine";
import { quotesRouter } from "./routes/quotes";
import type { Env } from "./env";

/* Ryoma, 2026-11-04: a ceiling the system filled in (last sales invoice, catalog price, COGS x 1,4)
   doesn't stop a margin target; a ceiling the client stated still does. Through the real routes,
   because the flag has to survive the server's item schema to reach the submit check. */

function freshDb() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = path.resolve(import.meta.dirname, "../../migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(path.join(dir, f), "utf8"));
  sqlite.exec(`INSERT INTO users(id, email, name, password_hash, role) VALUES (1, 'm@x', 'M', 'x', 'manager')`);
  return { sqlite, db: new D1DatabaseShim(sqlite) as unknown as D1Database };
}

function appFor(db: D1Database) {
  const app = new Hono<Env>();
  app.use(async (c, next) => {
    c.set("user", { id: 1, email: "m@x", name: "M", role: "manager" } as never);
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

const meta = { quoteNo: "", date: "2026-11-04", validity: 30, payment: "", delivery: "", notes: "", paymentDays: 30, warrantyYears: 1 };
// Landed 10.800 (opex 8%); 30% margin = 15.450, above the ceiling of 14.000.
const line = (over: Record<string, unknown>) => ({
  id: "a", lineNo: 1, code: "", name: "Lakban", uom: "Pcs", qty: 10, cogs: 10000, rrp: 14000, role: "CORE",
  manualPrice: [15450, null, null], ...over,
});

async function submit(over: Record<string, unknown>) {
  const { sqlite, db } = freshDb();
  const call = appFor(db);
  const created = await call("POST", "/api/quotes", {
    title: "Ceiling",
    snapshot: { assumptions: DEFAULT_ASSUMPTIONS, items: [line(over)], regions: [], meta, scenario: 0 },
  });
  expect(created.status).toBe(201);
  const id = created.json.quote.id;
  const stored = (await call("GET", `/api/quotes/${id}`)).json.quote.items[0];
  const sent = await call("POST", `/api/quotes/${id}/submit`);
  const approval = sqlite.prepare("SELECT breaches FROM approvals WHERE quote_id = ?").get(id) as { breaches: string } | undefined;
  const codes = (JSON.parse(approval?.breaches ?? "[]") as { code: string }[]).map((b) => b.code);
  return { stored, sent, codes, recorded: !!approval };
}

describe("default ceiling vs the client's ceiling, through POST /quotes and /submit", () => {
  it("a default ceiling is kept on save and a price above it is not ABOVE_CEILING", async () => {
    const r = await submit({ rrpDefault: true });
    expect(r.stored.rrpDefault).toBe(true);
    expect(r.sent.status).toBe(200);
    expect(r.recorded).toBe(true); // the check ran: an approval row with its breaches
    expect(r.codes).not.toContain("ABOVE_CEILING");
  });

  it("a client's ceiling (no flag, as every older quote) still blocks the same price", async () => {
    const r = await submit({});
    expect(r.sent.status).toBe(200);
    expect(r.codes).toContain("ABOVE_CEILING");
  });
});
