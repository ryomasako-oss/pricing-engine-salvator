import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { AlwaysAllowRateLimit, D1DatabaseShim } from "../../scripts/d1-sqlite-shim";
import { authRouter } from "./routes/auth";
import { accurateRouter } from "./routes/accurate";
import { catalogRouter } from "./routes/catalog";
import { hashPassword } from "./auth";
import { ROLE_PERMISSIONS } from "../../shared/permissions";
import type { Role } from "../../shared/types";
import type { Env } from "./env";

/* Audit P3-2, P3-3, P3-5 (23 Okt), through the real routes. */

function setup() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = path.resolve(import.meta.dirname, "../../migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(path.join(dir, f), "utf8"));
  const env = {
    DB: new D1DatabaseShim(sqlite) as unknown as D1Database,
    AUTH_LIMITER: new AlwaysAllowRateLimit(),
    JWT_SECRET: "test-secret-at-least-16-chars",
  } as unknown as Env["Bindings"];
  const app = (role?: Role) => {
    const a = new Hono<Env>();
    if (role) {
      a.use(async (c, next) => {
        c.set("user", { id: 1, email: "x@x", name: "X", role } as never);
        await next();
      });
    }
    a.route("/api/auth", authRouter);
    a.route("/api/accurate", accurateRouter);
    a.route("/api/catalog", catalogRouter);
    return async (method: string, p: string, body?: unknown) => {
      const r = await a.request(p, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json" } }, env);
      return { status: r.status, json: (await r.json()) as Record<string, any> };
    };
  };
  return { sqlite, app };
}

afterEach(() => vi.restoreAllMocks());

describe("P3-2: login does the same work for an unknown email", () => {
  it("an unknown email still runs one PBKDF2 verify and gets the same 401", async () => {
    const { sqlite, app } = setup();
    sqlite.prepare("INSERT INTO users(email, name, password_hash, role) VALUES(?, ?, ?, ?)")
      .run("known@x.test", "Known", await hashPassword("correct-horse"), "rep");
    const login = app();
    // Warm-up: the dummy hash is built once per isolate, not per request.
    await login("POST", "/api/auth/login", { email: "warm@x.test", password: "whatever1" });

    const derive = vi.spyOn(crypto.subtle, "deriveBits");
    const unknown = await login("POST", "/api/auth/login", { email: "nobody@x.test", password: "whatever1" });
    const unknownCalls = derive.mock.calls.length;
    derive.mockClear();
    const wrong = await login("POST", "/api/auth/login", { email: "known@x.test", password: "whatever1" });

    expect(unknown.status).toBe(401);
    expect(unknown.json).toEqual(wrong.json);
    expect(unknownCalls).toBe(1);
    expect(derive.mock.calls.length).toBe(1);
  });
});

describe("P3-5: apply-cogs writes take edit_catalog, like the other COGS writes", () => {
  it("a role with import_catalog + view_costs but no edit_catalog may preview, not apply", async () => {
    const { app } = setup();
    // No role has this mix today; drop edit_catalog from manager for the test only.
    const original = ROLE_PERMISSIONS.manager;
    ROLE_PERMISSIONS.manager = original.filter((p) => p !== "edit_catalog");
    try {
      const asManager = app("manager");
      expect((await asManager("POST", "/api/accurate/apply-cogs", { dryRun: false })).status).toBe(403);
      // The preview isn't a write: it gets as far as the receipt check (no pass yet -> 409).
      expect((await asManager("POST", "/api/accurate/apply-cogs", { dryRun: true })).status).toBe(409);
    } finally {
      ROLE_PERMISSIONS.manager = original;
    }
  });

  it("a manager with today's permissions is not blocked by the gate", async () => {
    const { app } = setup();
    expect((await app("manager")("POST", "/api/accurate/apply-cogs", { dryRun: false })).status).toBe(409);
  });
});

describe("P3-3: ?withCogs=1 never hands a rep COGS", () => {
  it("rep gets the priced items without cogs; manager gets cogs", async () => {
    const { sqlite, app } = setup();
    sqlite.exec(`INSERT INTO catalog_items(code, name, uom, cogs, list_price) VALUES
      ('A1', 'Kertas', 'Pcs', 9000, 12000), ('B1', 'Pena', 'Pcs', 0, 5000)`);
    const rep = await app("rep")("GET", "/api/catalog?withCogs=1");
    expect(rep.json.items.map((i: any) => i.code)).toEqual(["A1"]);
    expect(rep.json.items.every((i: any) => !("cogs" in i))).toBe(true);
    const manager = await app("manager")("GET", "/api/catalog?withCogs=1");
    expect(manager.json.items[0].cogs).toBe(9000);
  });
});
