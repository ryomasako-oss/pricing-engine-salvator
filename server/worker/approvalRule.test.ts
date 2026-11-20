import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { D1DatabaseShim } from "../../scripts/d1-sqlite-shim";
import { quotesRouter } from "./routes/quotes";
import { settingsRouter } from "./routes/settings";
import { BLOCK_NEEDS_ADMIN, BLOCK_NEEDS_OTHER } from "./quoteService";
import type { Env } from "./env";

/*
 * Approving a quote with a block breach (2026-11-20). Before, only the quote's
 * creator was refused: a manager who edited and resubmitted a rep's quote could
 * approve their own numbers. Pengaturan > Kebijakan harga now also lets admins
 * require that only an admin approves.
 */

const USERS = {
  // The quote's creator. A manager because a rep can't put an off-catalog line on it;
  // the rule doesn't look at the creator's role.
  rep: { id: 1, email: "r@x", name: "Rep", role: "manager" },
  m1: { id: 2, email: "m1@x", name: "M1", role: "manager" },
  m2: { id: 3, email: "m2@x", name: "M2", role: "manager" },
  admin: { id: 4, email: "a@x", name: "A", role: "admin" },
} as const;
type Who = keyof typeof USERS;

function setup() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = path.resolve(import.meta.dirname, "../../migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(path.join(dir, f), "utf8"));
  for (const u of Object.values(USERS)) {
    sqlite.exec(`INSERT INTO users(id, email, name, password_hash, role) VALUES (${u.id}, '${u.email}', '${u.name}', 'x', '${u.role}')`);
  }
  const db = new D1DatabaseShim(sqlite) as unknown as D1Database;
  const env = { DB: db } as unknown as Env["Bindings"];
  const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
  return async (who: Who, method: string, url: string, body?: unknown) => {
    const app = new Hono<Env>();
    app.use(async (c, next) => {
      c.set("user", USERS[who] as never);
      await next();
    });
    app.route("/api/quotes", quotesRouter);
    app.route("/api/settings", settingsRouter);
    const r = await app.request(
      url,
      { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined },
      env,
      ctx,
    );
    return { status: r.status, json: (await r.json()) as Record<string, any> };
  };
}

// Same numbers as e2e/self-approve.spec.ts: the default policy blocks this quote.
const snapshot = {
  assumptions: {
    opex: 0.08, targetMargin: 0.05, leaderMargin: 0, profitDiscount: 0, rrpDiscount: 0.1,
    marginFloor: 0.05, ppn: 0.11, step: 50, months: 12, includeLogistics: false,
  },
  items: [{ id: "it1", lineNo: 1, code: "", name: "Kertas A4 80gsm", uom: "rim", qty: 100, cogs: 38000, rrp: 55000, role: "CORE" }],
  regions: [],
  meta: { quoteNo: "", date: "2026-01-01", validity: 30, payment: "", delivery: "", notes: "", paymentDays: 30, warrantyYears: 1 },
  scenario: 0,
};

async function repQuote(call: ReturnType<typeof setup>) {
  const created = await call("rep", "POST", "/api/quotes", { title: "Aturan ACC", snapshot });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  return created.json.quote as { id: number; version: number };
}

const approve = (call: ReturnType<typeof setup>, who: Who, id: number) =>
  call(who, "POST", `/api/quotes/${id}/decide`, { decision: "approved", note: "" });

describe("approving a quote with a block breach", () => {
  it("refuses the manager who edited and submitted a rep's quote; another manager may approve", async () => {
    const call = setup();
    const q = await repQuote(call);
    const edited = await call("m1", "PUT", `/api/quotes/${q.id}`, { snapshot, expected_version: q.version });
    expect(edited.status).toBe(200);
    const submitted = await call("m1", "POST", `/api/quotes/${q.id}/submit`);
    expect(submitted.json.quote.status).toBe("submitted");

    const own = await approve(call, "m1", q.id);
    expect(own.status).toBe(403);
    expect(own.json.error).toBe(BLOCK_NEEDS_OTHER);
    expect((await call("m1", "GET", `/api/quotes/${q.id}`)).json.approveRefusal).toBe(BLOCK_NEEDS_OTHER);

    expect((await call("m2", "GET", `/api/quotes/${q.id}`)).json.approveRefusal).toBeNull();
    const other = await approve(call, "m2", q.id);
    expect(other.status).toBe(200);
    expect(other.json.quote.status).toBe("approved");
  });

  it("refuses the submitter, not a manager who only decided an earlier round", async () => {
    const call = setup();
    const q = await repQuote(call);
    await call("rep", "POST", `/api/quotes/${q.id}/submit`);
    expect((await call("m2", "POST", `/api/quotes/${q.id}/decide`, { decision: "rejected", note: "Naikkan" })).status).toBe(200);
    await call("rep", "POST", `/api/quotes/${q.id}/submit`);
    expect((await approve(call, "m2", q.id)).status).toBe(200);
  });

  it("with Hanya admin set, a manager can't approve and an admin can", async () => {
    const call = setup();
    const settings = await call("admin", "GET", "/api/settings");
    const put = await call("admin", "PUT", "/api/settings/policy", { ...settings.json.policy, blockApprover: "admin" });
    expect(put.status).toBe(200);
    expect(put.json.policy.blockApprover).toBe("admin");

    const q = await repQuote(call);
    await call("rep", "POST", `/api/quotes/${q.id}/submit`);
    const byManager = await approve(call, "m2", q.id);
    expect(byManager.status).toBe(403);
    expect(byManager.json.error).toBe(BLOCK_NEEDS_ADMIN);
    // Rejecting stays open to managers.
    expect((await call("m2", "GET", `/api/quotes/${q.id}`)).json.approveRefusal).toBe(BLOCK_NEEDS_ADMIN);
    expect((await approve(call, "admin", q.id)).status).toBe(200);
  });

  it("a policy saved without the field keeps the manager-or-admin rule", async () => {
    const call = setup();
    const { blockApprover: _drop, ...old } = (await call("admin", "GET", "/api/settings")).json.policy;
    expect((await call("admin", "PUT", "/api/settings/policy", old)).json.policy.blockApprover).toBe("other");
    const q = await repQuote(call);
    await call("rep", "POST", `/api/quotes/${q.id}/submit`);
    expect((await approve(call, "m2", q.id)).status).toBe(200);
  });
});
