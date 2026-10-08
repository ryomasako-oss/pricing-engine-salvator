import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { D1DatabaseShim } from "../../scripts/d1-sqlite-shim";
import { pendingItemsRouter } from "./routes/pendingItems";
import type { Env } from "./env";

/*
 * Review of PR #23: "Ajukan ke Accurate" checked the request was a draft, then
 * wrote the status and the "Barang baru ke Accurate" task in a later batch. A
 * cancel landing in between left an open task, emailed every morning, for a
 * request nobody wants. Here the cancel lands right before the batch.
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
  app.route("/api/pending-items", pendingItemsRouter);
  const env = { DB: db } as unknown as Env["Bindings"];
  const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
  return async (method: string, url: string, body?: unknown) => {
    const r = await app.request(url, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }, env, ctx);
    return { status: r.status, json: (await r.json()) as Record<string, any> };
  };
}

describe("POST /pending-items/:id/submit when the request is cancelled before the write", () => {
  it("opens no task for the cancelled request", async () => {
    const { sqlite, db } = freshDb();
    const made = await appFor(db)("POST", "/api/pending-items", { name: "Lemari Baru", uom: "Unit" });
    expect(made.status).toBe(201);
    const id = made.json.item.id;

    const racing = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== "batch") return Reflect.get(target, prop, receiver);
        return (statements: D1PreparedStatement[]) => {
          sqlite.exec(`UPDATE pending_items SET status = 'cancelled' WHERE id = ${id}`);
          return target.batch(statements);
        };
      },
    });
    await appFor(racing)("POST", `/api/pending-items/${id}/submit`);

    expect(sqlite.prepare("SELECT status FROM pending_items WHERE id = ?").get(id)).toEqual({ status: "cancelled" });
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM fix_tasks WHERE kind = 'new_item' AND status = 'open'").get()).toEqual({ n: 0 });
  });
});
