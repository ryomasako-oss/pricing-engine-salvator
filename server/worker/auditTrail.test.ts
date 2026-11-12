import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { AlwaysAllowRateLimit, D1DatabaseShim } from "../../scripts/d1-sqlite-shim";
import { authRouter } from "./routes/auth";
import { catalogRouter } from "./routes/catalog";
import { approvalsRouter } from "./routes/approvals";
import { hashPassword } from "./auth";
import type { Role } from "../../shared/types";
import type { Env } from "./env";

/* Riwayat Audit (2026-11-12), through the real routes and migrations. */

function setup() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = path.resolve(import.meta.dirname, "../../migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(path.join(dir, f), "utf8"));
  sqlite.prepare("INSERT INTO users(id, email, name, password_hash, role) VALUES(1, 'm@x.test', 'Manajer', 'x', 'manager')").run();
  const env = {
    DB: new D1DatabaseShim(sqlite) as unknown as D1Database,
    AUTH_LIMITER: new AlwaysAllowRateLimit(),
    JWT_SECRET: "test-secret-at-least-16-chars",
  } as unknown as Env["Bindings"];
  const app = (role?: Role) => {
    const a = new Hono<Env>();
    if (role) {
      a.use(async (c, next) => {
        c.set("user", { id: 1, email: "m@x.test", name: "Manajer", role } as never);
        await next();
      });
    }
    a.route("/api/auth", authRouter);
    a.route("/api/catalog", catalogRouter);
    a.route("/api/approvals", approvalsRouter);
    return async (method: string, p: string, body?: unknown) => {
      const r = await a.request(p, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json" } }, env);
      return { status: r.status, json: (await r.json()) as Record<string, any> };
    };
  };
  const today = new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);
  return { sqlite, app, today };
}

describe("audit_log is append-only in the database", () => {
  it("refuses UPDATE and DELETE", () => {
    const { sqlite } = setup();
    sqlite.exec("INSERT INTO audit_log(actor_id, entity, entity_id, action) VALUES(1, 'quote', 1, 'created')");
    expect(() => sqlite.exec("UPDATE audit_log SET action = 'x'")).toThrow(/append-only/);
    expect(() => sqlite.exec("DELETE FROM audit_log")).toThrow(/append-only/);
    expect(sqlite.prepare("SELECT action FROM audit_log").get()).toEqual({ action: "created" });
  });
});

describe("catalog edit records old → new", () => {
  it("logs only the fields that changed, with their old values", async () => {
    const { sqlite, app } = setup();
    sqlite.exec("INSERT INTO catalog_items(id, code, name, uom, cogs, list_price, category) VALUES(7, 'A1', 'Kertas', 'Rim', 10000, 15000, '')");
    const r = await app("manager")("PUT", "/api/catalog/7", { name: "Kertas", uom: "Rim", cogs: 12500, list_price: 15000, category: "" });
    expect(r.status).toBe(200);
    const row = sqlite.prepare("SELECT detail FROM audit_log WHERE entity = 'catalog' AND action = 'updated'").get() as { detail: string };
    expect(JSON.parse(row.detail)).toEqual({ code: "A1", before: { cogs: 10000 }, after: { cogs: 12500 } });
  });
});

describe("failed login is logged", () => {
  it("for a wrong password and for an unknown email alike, never the password", async () => {
    const { sqlite, app } = setup();
    sqlite.prepare("INSERT INTO users(id, email, name, password_hash, role) VALUES(2, 'r@x.test', 'Rep', ?, 'rep')").run(await hashPassword("correct-horse"));
    const login = app();
    expect((await login("POST", "/api/auth/login", { email: "R@x.test", password: "wrong-pass" })).status).toBe(401);
    expect((await login("POST", "/api/auth/login", { email: "nobody@x.test", password: "wrong-pass" })).status).toBe(401);
    const rows = sqlite.prepare("SELECT actor_id, entity_id, detail FROM audit_log WHERE action = 'login_failed' ORDER BY id").all() as any[];
    expect(rows.map((r) => [r.actor_id, r.entity_id, JSON.parse(r.detail).email])).toEqual([[null, 2, "r@x.test"], [null, 0, "nobody@x.test"]]);
    expect(rows.every((r) => !r.detail.includes("wrong-pass"))).toBe(true);
  });
});

describe("GET /api/approvals/audit", () => {
  it("filters by date, data kind and text, and counts every match", async () => {
    const { sqlite, app, today } = setup();
    const ins = sqlite.prepare("INSERT INTO audit_log(actor_id, entity, entity_id, action, detail, created_at) VALUES(1, ?, ?, ?, ?, ?)");
    ins.run("quote", 1, "created", '{"number":"Q-1"}', "2026-01-05 03:00:00");
    for (let i = 0; i < 3; i++) ins.run("catalog", i, "updated", `{"code":"K${i}"}`, new Date().toISOString().slice(0, 19).replace("T", " "));
    const get = app("manager");

    const all = await get("GET", `/api/approvals/audit?from=2026-01-01&to=${today}`);
    expect(all.status).toBe(200);
    expect(all.json.total).toBe(4);
    expect(all.json.entries[0]).toMatchObject({ actor_name: "Manajer", entity: "catalog" });

    expect((await get("GET", `/api/approvals/audit?from=2026-01-01&to=${today}&entity=quote`)).json.total).toBe(1);
    expect((await get("GET", `/api/approvals/audit?from=2026-01-01&to=${today}&q=K2`)).json.entries.map((e: any) => e.entity_id)).toEqual([2]);
    // "_" and "%" are literal, not wildcards.
    expect((await get("GET", `/api/approvals/audit?from=2026-01-01&to=${today}&q=%25`)).json.total).toBe(0);
    expect((await get("GET", "/api/approvals/audit?from=2026-01-06&to=2026-01-31")).json.total).toBe(0);
  });

  it("rejects a bad range and is closed to sales", async () => {
    const { app } = setup();
    expect((await app("manager")("GET", "/api/approvals/audit?from=2026-13-45&to=2026-12-01")).status).toBe(400);
    expect((await app("manager")("GET", "/api/approvals/audit?from=2026-02-01&to=2026-01-01")).status).toBe(400);
    expect((await app("rep")("GET", "/api/approvals/audit?from=2026-01-01&to=2026-01-31")).status).toBe(403);
  });
});
