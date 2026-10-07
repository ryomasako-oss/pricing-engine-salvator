import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { D1DatabaseShim } from "../../scripts/d1-sqlite-shim";
import { DEFAULT_ASSUMPTIONS } from "../../shared/engine";
import { quotesRouter } from "./routes/quotes";
import type { Env } from "./env";

/*
 * Codex review of develop 1fee9ed: POST /quotes/:id/sales-review read and
 * checked the quote, then wrote in a later batch without checking it again.
 * Two imports of the same file could both write (the second putting the
 * first's rejected line back on offer), and an import could change a quote
 * that had been sent in between. Here the quote changes right before the
 * import's batch reaches the database, which is the window either race uses.
 */

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
    const r = await app.request(
      url,
      { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined },
      env,
      ctx,
    );
    return { status: r.status, json: (await r.json()) as Record<string, any> };
  };
}

const item = (id: string, lineNo: number) => ({
  id, lineNo, code: `R-${id}`, name: `Item ${id}`, uom: "Pcs", qty: 10, cogs: 38000, rrp: 55000, role: "CORE",
});
const meta = { quoteNo: "", date: "2026-10-07", validity: 30, payment: "", delivery: "", notes: "", paymentDays: 30, warrantyYears: 1 };

describe("POST /quotes/:id/sales-review when the quote changes before the write", () => {
  it("refuses with 409 and writes nothing when the quote was sent in between", async () => {
    const { sqlite, db } = freshDb();
    const setup = appFor(db);
    const created = await setup("POST", "/api/quotes", {
      title: "Race",
      snapshot: { assumptions: DEFAULT_ASSUMPTIONS, items: [item("a", 1), item("b", 2)], regions: [], meta, scenario: 0 },
    });
    expect(created.status).toBe(201);
    const id = created.json.quote.id;
    const submitted = await setup("POST", `/api/quotes/${id}/submit`);
    expect(submitted.json.quote.status).toBe("approved");
    const { rev_no, version } = submitted.json.quote;

    // The quote is sent right before the import's batch reaches the database.
    const racing = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== "batch") return Reflect.get(target, prop, receiver);
        return (statements: D1PreparedStatement[]) => {
          sqlite.exec(`UPDATE quotes SET status = 'sent' WHERE id = ${id}`);
          return target.batch(statements);
        };
      },
    });
    const r = await appFor(racing)("POST", `/api/quotes/${id}/sales-review`, {
      rev_no,
      version,
      lines: [
        { id: "a", decision: "tolak", reason: "klien minta lebih murah" },
        { id: "b", decision: "acc", reason: "" },
      ],
    });

    expect(r.status).toBe(409);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM sales_reviews").get()).toEqual({ n: 0 });
    const row = sqlite.prepare("SELECT status, version, items FROM quotes WHERE id = ?").get(id) as { status: string; version: number; items: string };
    expect([row.status, row.version]).toEqual(["sent", version]);
    expect(JSON.parse(row.items).some((it: { held?: boolean }) => it.held)).toBe(false);
  });
});

describe("a sales rejection after a manager's decision commits", () => {
  it("requires another explicit approval even if the decision request has not finished", async () => {
    const { sqlite, db } = freshDb();
    try {
      const setup = appFor(db);
      const created = await setup("POST", "/api/quotes", {
        title: "Decision audit race",
        snapshot: { assumptions: DEFAULT_ASSUMPTIONS, items: [item("a", 1)], regions: [], meta, scenario: 0 },
      });
      expect(created.status).toBe(201);
      const id = created.json.quote.id;
      const reject = async (quote: { rev_no: number; version: number }) =>
        setup("POST", `/api/quotes/${id}/sales-review`, {
          rev_no: quote.rev_no,
          version: quote.version,
          lines: [{ id: "a", decision: "tolak", reason: "klien minta lebih murah" }],
        });

      const initial = await setup("POST", `/api/quotes/${id}/submit`);
      expect(initial.json.quote.status).toBe("approved");
      expect((await reject(initial.json.quote)).status).toBe(200);
      const pending = await setup("POST", `/api/quotes/${id}/submit`);
      expect(pending.json.quote.status).toBe("submitted");

      // Another request observes the committed approval and rejects it before
      // the decision handler resumes. Audit order must reflect that order too.
      const racing = new Proxy(db, {
        get(target, prop, receiver) {
          if (prop !== "batch") return Reflect.get(target, prop, receiver);
          return async (statements: D1PreparedStatement[]) => {
            const results = await target.batch(statements);
            const approved = await setup("GET", `/api/quotes/${id}`);
            expect(approved.json.quote.status).toBe("approved");
            expect((await reject(approved.json.quote)).status).toBe(200);
            return results;
          };
        },
      });
      const decided = await appFor(racing)("POST", `/api/quotes/${id}/decide`, { decision: "approved", note: "" });
      expect(decided.status).toBe(200);
      expect(decided.json.quote.status).toBe("draft");

      const resubmitted = await setup("POST", `/api/quotes/${id}/submit`);
      expect(resubmitted.status).toBe(200);
      expect(resubmitted.json.autoApproved).toBe(false);
      expect(resubmitted.json.quote.status).toBe("submitted");
    } finally {
      sqlite.close();
    }
  });
});
