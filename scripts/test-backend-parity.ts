/* ============================================================
   Parity test: Express/node:sqlite backend vs. Worker/D1 backend.

   The project note for this codebase flags that these two backends
   duplicate the same route/service logic (server/routes/quotes.ts vs
   server/worker/routes/quotes.ts) and "had already drifted once
   before". This script runs the *same* sequence of real HTTP-shaped
   requests against both real route files and diffs the meaningful
   parts of every response — so a future edit that touches one side
   but not its twin gets caught automatically instead of by manual
   review.

   The Worker side runs against a D1Database shim backed by
   node:sqlite (see d1-sqlite-shim.ts) rather than a full `wrangler
   dev`/workerd instance: D1 is SQLite underneath, so statement
   semantics line up, and this stays fast and dependency-free. It is
   not a substitute for occasionally smoke-testing the real Worker
   with `wrangler dev` — it only proves the two route/service files
   make the same decisions given the same inputs.

   Run: npx tsx scripts/test-backend-parity.ts
   ============================================================ */

import { DatabaseSync } from "node:sqlite";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { D1DatabaseShim, AlwaysAllowRateLimit } from "./d1-sqlite-shim.js";

type Session = { cookie: string };
type ApiResult = { status: number; json: any };

interface Driver {
  name: string;
  api(method: string, routePath: string, opts?: { body?: unknown; session?: Session }): Promise<ApiResult>;
  login(email: string, password: string): Promise<Session>;
  seedUser(email: string, name: string, role: "rep" | "manager" | "admin", password: string): Promise<void>;
  teardown(): Promise<void>;
}

// ---------------------------------------------------------------
// Express driver — real app.listen(), real node:sqlite.
// ---------------------------------------------------------------
async function makeExpressDriver(): Promise<Driver> {
  const dbDir = mkdtempSync(path.join(tmpdir(), "hk-parity-express-"));
  process.env.DATABASE_PATH = path.join(dbDir, "test.db");
  process.env.JWT_SECRET = "test-only-secret-not-for-production-0000000000";
  process.env.NODE_ENV = "test";

  const express = (await import("express")).default;
  const cookieParser = (await import("cookie-parser")).default;
  const { loadUser, hashPassword } = await import("../server/auth.js");
  const { authRouter } = await import("../server/routes/auth.js");
  const { quotesRouter } = await import("../server/routes/quotes.js");
  const { approvalsRouter } = await import("../server/routes/approvals.js");
  const { catalogRouter } = await import("../server/routes/catalog.js");
  const { clientsRouter } = await import("../server/routes/clients.js");
  const { settingsRouter } = await import("../server/routes/settings.js");
  const { assistantRouter } = await import("../server/routes/assistant.js");
  const { run } = await import("../server/db.js");

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(loadUser);
  app.use("/api/auth", authRouter);
  app.use("/api/quotes", quotesRouter);
  app.use("/api/approvals", approvalsRouter);
  app.use("/api/catalog", catalogRouter);
  app.use("/api/clients", clientsRouter);
  app.use("/api/settings", settingsRouter);
  app.use("/api/assistant", assistantRouter);

  let server: Server;
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  const address = server!.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    name: "express",
    async api(method, routePath, opts = {}) {
      const res = await fetch(`${baseUrl}${routePath}`, {
        method,
        headers: {
          "content-type": "application/json",
          ...(opts.session ? { cookie: opts.session.cookie } : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
      const setCookie = res.headers.get("set-cookie");
      const cookie = setCookie ? setCookie.split(";")[0] : undefined;
      const json = res.status === 204 ? null : await res.json().catch(() => null);
      return { status: res.status, json: cookie ? { ...json, __cookie: cookie } : json };
    },
    async login(email, password) {
      const r = await this.api("POST", "/api/auth/login", { body: { email, password } });
      if (r.status !== 200 || !r.json?.__cookie) throw new Error(`express login failed: ${r.status}`);
      return { cookie: r.json.__cookie };
    },
    async seedUser(email, name, role, password) {
      run(
        `INSERT INTO users(email, name, password_hash, role) VALUES(?, ?, ?, ?)`,
        email,
        name,
        hashPassword(password),
        role,
      );
    },
    async teardown() {
      await new Promise((resolve) => server!.close(resolve));
      rmSync(dbDir, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------
// Worker driver — real Hono app.request(), D1 shim over node:sqlite.
// ---------------------------------------------------------------
async function makeWorkerDriver(): Promise<Driver> {
  const sqlite = new DatabaseSync(":memory:");
  const migrationsDir = path.resolve(import.meta.dirname, "../migrations");
  for (const file of [
    "0001_init.sql",
    "0002_consistency.sql",
    "0003_password_reset_requests.sql",
    "0004_user_phone.sql",
    "0005_reassignment_and_restore.sql",
    "0006_uom_options.sql",
    "0007_catalog_item_uoms.sql",
    "0008_catalog_aliases.sql",
    "0009_cogs_sanity.sql",
  ]) {
    sqlite.exec(readFileSync(path.join(migrationsDir, file), "utf8"));
  }
  const db = new D1DatabaseShim(sqlite) as unknown as D1Database;

  const { Hono } = await import("hono");
  const { hashPassword, loadUser } = await import("../server/worker/auth.js");
  const { authRouter } = await import("../server/worker/routes/auth.js");
  const { quotesRouter } = await import("../server/worker/routes/quotes.js");
  const { approvalsRouter } = await import("../server/worker/routes/approvals.js");
  const { catalogRouter } = await import("../server/worker/routes/catalog.js");
  const { clientsRouter } = await import("../server/worker/routes/clients.js");
  const { settingsRouter } = await import("../server/worker/routes/settings.js");
  const { assistantRouter } = await import("../server/worker/routes/assistant.js");
  const { run } = await import("../server/db.d1.js");

  const app = new Hono();
  app.use(loadUser);
  app.route("/api/auth", authRouter);
  app.route("/api/quotes", quotesRouter);
  app.route("/api/approvals", approvalsRouter);
  app.route("/api/catalog", catalogRouter);
  app.route("/api/clients", clientsRouter);
  app.route("/api/settings", settingsRouter);
  app.route("/api/assistant", assistantRouter);

  const env = {
    DB: db,
    JWT_SECRET: "test-only-secret-not-for-production-0000000000",
    NODE_ENV: "test",
    AUTH_LIMITER: new AlwaysAllowRateLimit() as unknown as RateLimit,
    ASSISTANT_LIMITER: new AlwaysAllowRateLimit() as unknown as RateLimit,
  };

  // Hono's Context.executionCtx throws if no real ExecutionContext is passed
  // to app.request() — routes that call c.executionCtx.waitUntil() (the
  // notification fire-and-forget calls) need this stub to not crash.
  const executionCtx = {
    waitUntil: (promise: Promise<unknown>) => {
      promise.catch(() => undefined);
    },
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext;

  return {
    name: "worker",
    async api(method, routePath, opts = {}) {
      const res = await app.request(
        routePath,
        {
          method,
          headers: {
            "content-type": "application/json",
            ...(opts.session ? { cookie: opts.session.cookie } : {}),
          },
          body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        },
        env,
        executionCtx,
      );
      const setCookie = res.headers.get("set-cookie");
      const cookie = setCookie ? setCookie.split(";")[0] : undefined;
      const json = res.status === 204 ? null : await res.json().catch(() => null);
      return { status: res.status, json: cookie ? { ...json, __cookie: cookie } : json };
    },
    async login(email, password) {
      const r = await this.api("POST", "/api/auth/login", { body: { email, password } });
      if (r.status !== 200 || !r.json?.__cookie) throw new Error(`worker login failed: ${r.status}`);
      return { cookie: r.json.__cookie };
    },
    async seedUser(email, name, role, password) {
      await run(
        db,
        `INSERT INTO users(email, name, password_hash, role) VALUES(?, ?, ?, ?)`,
        email,
        name,
        await hashPassword(password),
        role,
      );
    },
    async teardown() {
      /* in-memory sqlite, nothing to clean up */
    },
  };
}

// ---------------------------------------------------------------
// Scenario helpers, backend-agnostic.
// ---------------------------------------------------------------

function cleanItem(over: Record<string, unknown> = {}) {
  return {
    id: "it1",
    lineNo: 1,
    code: "ATK-001",
    name: "Kertas A4 80gsm",
    uom: "rim",
    qty: 100,
    cogs: 38000,
    rrp: 55000,
    role: "CORE",
    ...over,
  };
}

const DEFAULT_ASSUMPTIONS = {
  opex: 0.08,
  targetMargin: 0.25,
  leaderMargin: 0.1,
  profitDiscount: 0.0,
  rrpDiscount: 0.1,
  marginFloor: 0.05,
  ppn: 0.11,
  step: 50,
  months: 12,
  includeLogistics: false,
};

function snapshotFor(items: ReturnType<typeof cleanItem>[], overAssumptions: Record<string, unknown> = {}) {
  return {
    assumptions: { ...DEFAULT_ASSUMPTIONS, ...overAssumptions },
    items,
    regions: [],
    meta: { quoteNo: "", date: "2026-01-01", validity: 30, payment: "", delivery: "", notes: "", paymentDays: 30, warrantyYears: 1 },
    scenario: 0,
  };
}

/** Sessions that belong to staff (role rep), so createDraft knows how a rep builds a quote. */
const repSessions = new WeakSet<Session>();

/**
 * A draft owned by `session`. A manager sends the full snapshot. A rep can't
 * send cost inputs (PE-1), so the lines are first put in the catalog by a
 * manager (one code per distinct COGS, so no scenario moves another's COGS
 * reference) and the rep quotes them by code. A rep can't set assumptions
 * either: asking for a policy breach gives the line a ceiling just above
 * cost, so the price is capped there and the margin breaks the policy.
 */
async function createDraft(
  driver: Driver,
  session: Session,
  items: ReturnType<typeof cleanItem>[],
  overAssumptions: Record<string, unknown> = {},
) {
  let snapshot: unknown = snapshotFor(items, overAssumptions);
  if (repSessions.has(session)) {
    const breach = Object.keys(overAssumptions).length > 0;
    const lines = items.map((it) => ({ ...it, code: `${it.code}@${it.cogs}`, rrp: breach ? Math.round(it.cogs * 1.1) : it.rrp }));
    const manager = await loginCached(driver, "manager@test.local", "password123");
    const imp = await driver.api("POST", "/api/catalog/import", {
      body: {
        rows: lines.map((it) => ({ code: it.code, name: it.name, uom: it.priceUom ?? it.uom, cogs: it.cogs, list_price: it.rrp })),
        mode: "merge",
      },
      session: manager,
    });
    assert.equal(imp.status, 200, `[${driver.name}] catalog seed failed: ${JSON.stringify(imp.json)}`);
    snapshot = { ...snapshotFor(lines, overAssumptions), items: lines };
  }
  const created = await driver.api("POST", "/api/quotes", { body: { title: "Test quote", snapshot }, session });
  assert.equal(created.status, 201, `[${driver.name}] create draft failed: ${JSON.stringify(created.json)}`);
  return created.json.quote as { id: number; version: number; number: string };
}

// Both real login endpoints are rate-limited; logging in fresh on every
// scenario would trip that limit long before comparing business logic.
const sessionCache = new Map<string, Session>();
async function loginCached(d: Driver, email: string, password: string): Promise<Session> {
  const key = `${d.name}:${email}`;
  const cached = sessionCache.get(key);
  if (cached) return cached;
  const session = await d.login(email, password);
  if (/^rep\d*@/.test(email)) repSessions.add(session);
  sessionCache.set(key, session);
  return session;
}

// ---------------------------------------------------------------
// Scenarios: each returns the fields worth comparing between backends.
// Timestamps and the raw cookie are deliberately excluded.
// ---------------------------------------------------------------

type Scenario = { name: string; run: (d: Driver) => Promise<Record<string, unknown>> };
const scenarios: Scenario[] = [];
const scenario = (name: string, run: Scenario["run"]) => scenarios.push({ name, run });

scenario("rep submits a clean quote -> pending, not auto-approved", async (d) => {
  const rep = await loginCached(d, "rep@test.local", "password123");
  const quote = await createDraft(d, rep, [cleanItem()]);
  const submitted = await d.api("POST", `/api/quotes/${quote.id}/submit`, { session: rep });
  return {
    status: submitted.status,
    autoApproved: submitted.json.autoApproved,
    quoteStatus: submitted.json.quote.status,
    breachCodes: submitted.json.breaches.map((b: { code: string }) => b.code),
  };
});

scenario("manager submits a clean quote -> auto-approved", async (d) => {
  const manager = await loginCached(d, "manager@test.local", "password123");
  const quote = await createDraft(d, manager, [cleanItem()]);
  const submitted = await d.api("POST", `/api/quotes/${quote.id}/submit`, { session: manager });
  return {
    status: submitted.status,
    autoApproved: submitted.json.autoApproved,
    quoteStatus: submitted.json.quote.status,
    approvedByIsSet: submitted.json.quote.approved_by != null,
  };
});

scenario("rep submits a policy-breaching quote -> pending with breach codes", async (d) => {
  const rep = await loginCached(d, "rep@test.local", "password123");
  const quote = await createDraft(d, rep, [cleanItem()], { targetMargin: 0.05, leaderMargin: 0.0 });
  const submitted = await d.api("POST", `/api/quotes/${quote.id}/submit`, { session: rep });
  return {
    status: submitted.status,
    autoApproved: submitted.json.autoApproved,
    quoteStatus: submitted.json.quote.status,
    breachCodes: submitted.json.breaches.map((b: { code: string }) => b.code).sort(),
  };
});

scenario("manager submits a breaching quote -> NOT auto-approved despite permission", async (d) => {
  const manager = await loginCached(d, "manager@test.local", "password123");
  const quote = await createDraft(d, manager, [cleanItem()], { targetMargin: 0.05, leaderMargin: 0.0 });
  const submitted = await d.api("POST", `/api/quotes/${quote.id}/submit`, { session: manager });
  return {
    status: submitted.status,
    autoApproved: submitted.json.autoApproved,
    quoteStatus: submitted.json.quote.status,
  };
});

scenario("submitting an already-submitted quote -> 409", async (d) => {
  const rep = await loginCached(d, "rep@test.local", "password123");
  const quote = await createDraft(d, rep, [cleanItem()]);
  await d.api("POST", `/api/quotes/${quote.id}/submit`, { session: rep });
  const again = await d.api("POST", `/api/quotes/${quote.id}/submit`, { session: rep });
  return { status: again.status };
});

scenario("rep cannot decide (403)", async (d) => {
  const rep = await loginCached(d, "rep@test.local", "password123");
  const quote = await createDraft(d, rep, [cleanItem()], { targetMargin: 0.05, leaderMargin: 0.0 });
  await d.api("POST", `/api/quotes/${quote.id}/submit`, { session: rep });
  const decided = await d.api("POST", `/api/quotes/${quote.id}/decide`, {
    body: { decision: "approved", note: "" },
    session: rep,
  });
  return { status: decided.status };
});

scenario("manager approves a pending quote", async (d) => {
  const rep = await loginCached(d, "rep@test.local", "password123");
  const manager = await loginCached(d, "manager@test.local", "password123");
  const quote = await createDraft(d, rep, [cleanItem()], { targetMargin: 0.05, leaderMargin: 0.0 });
  await d.api("POST", `/api/quotes/${quote.id}/submit`, { session: rep });
  const decided = await d.api("POST", `/api/quotes/${quote.id}/decide`, {
    body: { decision: "approved", note: "Dispensasi khusus" },
    session: manager,
  });
  return {
    status: decided.status,
    quoteStatus: decided.json.quote.status,
    decisionNote: decided.json.quote.decision_note,
  };
});

scenario("rejecting without a note -> 400", async (d) => {
  const rep = await loginCached(d, "rep@test.local", "password123");
  const manager = await loginCached(d, "manager@test.local", "password123");
  const quote = await createDraft(d, rep, [cleanItem()], { targetMargin: 0.05, leaderMargin: 0.0 });
  await d.api("POST", `/api/quotes/${quote.id}/submit`, { session: rep });
  const decided = await d.api("POST", `/api/quotes/${quote.id}/decide`, {
    body: { decision: "rejected", note: "" },
    session: manager,
  });
  return { status: decided.status };
});

scenario("manager rejects with a note", async (d) => {
  const rep = await loginCached(d, "rep@test.local", "password123");
  const manager = await loginCached(d, "manager@test.local", "password123");
  const quote = await createDraft(d, rep, [cleanItem()], { targetMargin: 0.05, leaderMargin: 0.0 });
  await d.api("POST", `/api/quotes/${quote.id}/submit`, { session: rep });
  const decided = await d.api("POST", `/api/quotes/${quote.id}/decide`, {
    body: { decision: "rejected", note: "Margin terlalu tipis." },
    session: manager,
  });
  return { status: decided.status, quoteStatus: decided.json.quote.status };
});

scenario("deciding a draft (not pending) -> 409", async (d) => {
  const manager = await loginCached(d, "manager@test.local", "password123");
  const quote = await createDraft(d, manager, [cleanItem()]);
  const decided = await d.api("POST", `/api/quotes/${quote.id}/decide`, {
    body: { decision: "approved", note: "" },
    session: manager,
  });
  return { status: decided.status };
});

scenario("stale expected_version -> 409, does not overwrite", async (d) => {
  const rep = await loginCached(d, "rep@test.local", "password123");
  const quote = await createDraft(d, rep, [cleanItem()]);
  const staleVersion = quote.version;
  const first = await d.api("PUT", `/api/quotes/${quote.id}`, {
    body: { snapshot: snapshotFor([cleanItem({ qty: 200 })]), expected_version: staleVersion },
    session: rep,
  });
  const second = await d.api("PUT", `/api/quotes/${quote.id}`, {
    body: { snapshot: snapshotFor([cleanItem({ qty: 300 })]), expected_version: staleVersion },
    session: rep,
  });
  return {
    firstStatus: first.status,
    firstVersion: first.json.quote.version,
    secondStatus: second.status,
    winningQty: second.json.quote.items[0].qty,
  };
});

scenario("correct expected_version -> succeeds, bumps version", async (d) => {
  const rep = await loginCached(d, "rep@test.local", "password123");
  const quote = await createDraft(d, rep, [cleanItem()]);
  const saved = await d.api("PUT", `/api/quotes/${quote.id}`, {
    body: { snapshot: snapshotFor([cleanItem({ qty: 500 })]), expected_version: quote.version },
    session: rep,
  });
  return { status: saved.status, version: saved.json.quote.version, qty: saved.json.quote.items[0].qty };
});

scenario("a locked (submitted) quote cannot be edited", async (d) => {
  const rep = await loginCached(d, "rep@test.local", "password123");
  const quote = await createDraft(d, rep, [cleanItem()]);
  await d.api("POST", `/api/quotes/${quote.id}/submit`, { session: rep });
  const saved = await d.api("PUT", `/api/quotes/${quote.id}`, {
    body: { snapshot: snapshotFor([cleanItem({ qty: 999 })]), expected_version: quote.version },
    session: rep,
  });
  return { status: saved.status };
});

scenario("a different rep cannot submit someone else's draft (403)", async (d) => {
  const rep = await loginCached(d, "rep@test.local", "password123");
  const rep2 = await loginCached(d, "rep2@test.local", "password123");
  const quote = await createDraft(d, rep, [cleanItem()]);
  const submitted = await d.api("POST", `/api/quotes/${quote.id}/submit`, { session: rep2 });
  return { status: submitted.status };
});

scenario("a manager CAN submit another rep's draft (edit_all_quotes)", async (d) => {
  const rep = await loginCached(d, "rep@test.local", "password123");
  const manager = await loginCached(d, "manager@test.local", "password123");
  const quote = await createDraft(d, rep, [cleanItem()]);
  const submitted = await d.api("POST", `/api/quotes/${quote.id}/submit`, { session: manager });
  return { status: submitted.status, quoteStatus: submitted.json.quote.status };
});

scenario("a rep cannot read the company-wide approval queue (403)", async (d) => {
  const rep = await loginCached(d, "rep@test.local", "password123");
  const listed = await d.api("GET", "/api/approvals?decision=pending", { session: rep });
  return { status: listed.status };
});

scenario("a manager CAN read the approval queue", async (d) => {
  const manager = await loginCached(d, "manager@test.local", "password123");
  const listed = await d.api("GET", "/api/approvals?decision=pending", { session: manager });
  return { status: listed.status, isArray: Array.isArray(listed.json.approvals) };
});

scenario("a user can set and clear their own WhatsApp number", async (d) => {
  const rep = await loginCached(d, "rep@test.local", "password123");
  const set = await d.api("PATCH", "/api/auth/profile", { body: { phone: "+6281234567890" }, session: rep });
  const cleared = await d.api("PATCH", "/api/auth/profile", { body: { phone: "" }, session: rep });
  return { setStatus: set.status, setPhone: set.json.user.phone, clearedPhone: cleared.json.user.phone };
});

scenario("an invalid WhatsApp number is rejected with 400", async (d) => {
  const rep = await loginCached(d, "rep@test.local", "password123");
  const updated = await d.api("PATCH", "/api/auth/profile", { body: { phone: "not-a-phone!!" }, session: rep });
  return { status: updated.status };
});

scenario("rep cannot reassign a quote (403)", async (d) => {
  const rep = await loginCached(d, "rep@test.local", "password123");
  const rep2 = await loginCached(d, "rep2@test.local", "password123");
  const quote = await createDraft(d, rep, [cleanItem()]);
  const rep2User = await d.api("GET", "/api/auth/me", { session: rep2 });
  const reassigned = await d.api("POST", `/api/quotes/${quote.id}/reassign`, {
    body: { assigned_to: rep2User.json.user.id, note: "" },
    session: rep,
  });
  return { status: reassigned.status };
});

scenario("reassigning to an unknown user -> 400", async (d) => {
  const manager = await loginCached(d, "manager@test.local", "password123");
  const rep = await loginCached(d, "rep@test.local", "password123");
  const quote = await createDraft(d, rep, [cleanItem()]);
  const reassigned = await d.api("POST", `/api/quotes/${quote.id}/reassign`, {
    body: { assigned_to: 999999, note: "" },
    session: manager,
  });
  return { status: reassigned.status };
});

scenario("manager reassigns a draft, the new assignee can then edit it", async (d) => {
  const manager = await loginCached(d, "manager@test.local", "password123");
  const rep = await loginCached(d, "rep@test.local", "password123");
  const rep2 = await loginCached(d, "rep2@test.local", "password123");
  const quote = await createDraft(d, rep, [cleanItem()]);
  const rep2User = await d.api("GET", "/api/auth/me", { session: rep2 });
  const reassigned = await d.api("POST", `/api/quotes/${quote.id}/reassign`, {
    body: { assigned_to: rep2User.json.user.id, note: "Rep asli cuti" },
    session: manager,
  });
  const editedByNewAssignee = await d.api("PUT", `/api/quotes/${quote.id}`, {
    body: { snapshot: snapshotFor([cleanItem({ qty: 250 })]), expected_version: reassigned.json.quote.version },
    session: rep2,
  });
  return {
    reassignStatus: reassigned.status,
    assignedToIsSet: reassigned.json.quote.assigned_to != null,
    editStatus: editedByNewAssignee.status,
    editedQty: editedByNewAssignee.json.quote.items[0].qty,
  };
});

scenario("reassigning a quote records a history entry naming the new owner", async (d) => {
  const manager = await loginCached(d, "manager@test.local", "password123");
  const rep = await loginCached(d, "rep@test.local", "password123");
  const rep2 = await loginCached(d, "rep2@test.local", "password123");
  const quote = await createDraft(d, rep, [cleanItem()]);
  const rep2User = await d.api("GET", "/api/auth/me", { session: rep2 });
  await d.api("POST", `/api/quotes/${quote.id}/reassign`, {
    body: { assigned_to: rep2User.json.user.id, note: "Cakupan cuti" },
    session: manager,
  });
  const detail = await d.api("GET", `/api/quotes/${quote.id}`, { session: rep });
  const notes = detail.json.revisions.map((r: { note: string }) => r.note);
  return { hasHandoffEntry: notes.some((n: string) => n === "Dialihkan ke Rep Two: Cakupan cuti") };
});

scenario("unassigning a quote records a distinct history entry", async (d) => {
  const manager = await loginCached(d, "manager@test.local", "password123");
  const rep = await loginCached(d, "rep@test.local", "password123");
  const rep2 = await loginCached(d, "rep2@test.local", "password123");
  const quote = await createDraft(d, rep, [cleanItem()]);
  const rep2User = await d.api("GET", "/api/auth/me", { session: rep2 });
  await d.api("POST", `/api/quotes/${quote.id}/reassign`, { body: { assigned_to: rep2User.json.user.id, note: "" }, session: manager });
  await d.api("POST", `/api/quotes/${quote.id}/reassign`, { body: { assigned_to: null, note: "" }, session: manager });
  const detail = await d.api("GET", `/api/quotes/${quote.id}`, { session: rep });
  const notes = detail.json.revisions.map((r: { note: string }) => r.note);
  return { hasUnassignEntry: notes.includes("Penugasan dilepas") };
});

scenario("reassigning to the already-current assignee is a no-op (no duplicate history entry)", async (d) => {
  const manager = await loginCached(d, "manager@test.local", "password123");
  const rep = await loginCached(d, "rep@test.local", "password123");
  const rep2 = await loginCached(d, "rep2@test.local", "password123");
  const quote = await createDraft(d, rep, [cleanItem()]);
  const rep2User = await d.api("GET", "/api/auth/me", { session: rep2 });
  await d.api("POST", `/api/quotes/${quote.id}/reassign`, { body: { assigned_to: rep2User.json.user.id, note: "" }, session: manager });
  const before = await d.api("GET", `/api/quotes/${quote.id}`, { session: rep });
  const repeat = await d.api("POST", `/api/quotes/${quote.id}/reassign`, { body: { assigned_to: rep2User.json.user.id, note: "" }, session: manager });
  const after = await d.api("GET", `/api/quotes/${quote.id}`, { session: rep });
  return {
    repeatStatus: repeat.status,
    revisionCountUnchanged: before.json.revisions.length === after.json.revisions.length,
  };
});

scenario("won -> completed is an allowed manual status move", async (d) => {
  const manager = await loginCached(d, "manager@test.local", "password123");
  const quote = await createDraft(d, manager, [cleanItem()]);
  await d.api("POST", `/api/quotes/${quote.id}/submit`, { session: manager }); // manager auto-approves
  await d.api("POST", `/api/quotes/${quote.id}/status`, { body: { status: "sent" }, session: manager });
  await d.api("POST", `/api/quotes/${quote.id}/status`, { body: { status: "won" }, session: manager });
  const completed = await d.api("POST", `/api/quotes/${quote.id}/status`, { body: { status: "completed" }, session: manager });
  return { status: completed.status, quoteStatus: completed.json.quote?.status };
});

scenario("sent -> completed is rejected (must pass through won first) -> 409", async (d) => {
  const manager = await loginCached(d, "manager@test.local", "password123");
  const quote = await createDraft(d, manager, [cleanItem()]);
  await d.api("POST", `/api/quotes/${quote.id}/submit`, { session: manager });
  await d.api("POST", `/api/quotes/${quote.id}/status`, { body: { status: "sent" }, session: manager });
  const skip = await d.api("POST", `/api/quotes/${quote.id}/status`, { body: { status: "completed" }, session: manager });
  return { status: skip.status };
});

scenario("owner can reopen their own submitted quote directly, no manager decision needed", async (d) => {
  const rep = await loginCached(d, "rep@test.local", "password123");
  const quote = await createDraft(d, rep, [cleanItem()]);
  await d.api("POST", `/api/quotes/${quote.id}/submit`, { session: rep });
  const reopened = await d.api("POST", `/api/quotes/${quote.id}/reopen`, { session: rep });
  return { status: reopened.status, quoteStatus: reopened.json.quote?.status };
});

scenario("a different rep still cannot reopen someone else's submitted quote (403)", async (d) => {
  const rep = await loginCached(d, "rep@test.local", "password123");
  const rep2 = await loginCached(d, "rep2@test.local", "password123");
  const quote = await createDraft(d, rep, [cleanItem()]);
  await d.api("POST", `/api/quotes/${quote.id}/submit`, { session: rep });
  const reopened = await d.api("POST", `/api/quotes/${quote.id}/reopen`, { session: rep2 });
  return { status: reopened.status };
});

scenario("reopening a submitted quote clears it from the manager's pending-approval queue", async (d) => {
  const manager = await loginCached(d, "manager@test.local", "password123");
  const rep = await loginCached(d, "rep@test.local", "password123");
  const quote = await createDraft(d, rep, [cleanItem()], { targetMargin: 0.05, leaderMargin: 0.0 }); // breaches policy -> stays pending
  await d.api("POST", `/api/quotes/${quote.id}/submit`, { session: rep });
  const beforeQueue = await d.api("GET", "/api/approvals?decision=pending", { session: manager });
  await d.api("POST", `/api/quotes/${quote.id}/reopen`, { session: rep });
  const afterQueue = await d.api("GET", "/api/approvals?decision=pending", { session: manager });
  const inQueue = (rows: { quote_id: number }[]) => rows.some((r) => r.quote_id === quote.id);
  return {
    wasQueuedBefore: inQueue(beforeQueue.json.approvals),
    stillQueuedAfter: inQueue(afterQueue.json.approvals),
  };
});

scenario("rejecting a quote records who rejected it, visible on the quote itself", async (d) => {
  const rep = await loginCached(d, "rep@test.local", "password123");
  const manager = await loginCached(d, "manager@test.local", "password123");
  const quote = await createDraft(d, rep, [cleanItem()], { targetMargin: 0.05, leaderMargin: 0.0 });
  await d.api("POST", `/api/quotes/${quote.id}/submit`, { session: rep });
  const decided = await d.api("POST", `/api/quotes/${quote.id}/decide`, {
    body: { decision: "rejected", note: "Margin terlalu tipis." },
    session: manager,
  });
  return {
    approvedByIsSet: decided.json.quote.approved_by != null,
    approvedByName: decided.json.quote.approved_by_name,
  };
});

scenario("editing a quote (e.g. fixing it after a rejection) is recorded in the audit trail", async (d) => {
  const rep = await loginCached(d, "rep@test.local", "password123");
  const manager = await loginCached(d, "manager@test.local", "password123");
  const quote = await createDraft(d, rep, [cleanItem()], { targetMargin: 0.05, leaderMargin: 0.0 });
  await d.api("POST", `/api/quotes/${quote.id}/submit`, { session: rep });
  const decided = await d.api("POST", `/api/quotes/${quote.id}/decide`, {
    body: { decision: "rejected", note: "Tambah item dulu." },
    session: manager,
  });
  // Manager fixes it directly (edit_all_quotes lets them touch a rejected quote).
  await d.api("PUT", `/api/quotes/${quote.id}`, {
    body: { snapshot: snapshotFor([cleanItem(), cleanItem({ id: "it2", lineNo: 2, code: "ATK-002" })]), expected_version: decided.json.quote.version },
    session: manager,
  });
  const detail = await d.api("GET", `/api/quotes/${quote.id}`, { session: rep });
  const editEntry = detail.json.audit.find((a: { action: string }) => a.action === "edited");
  return { hasEditAuditEntry: Boolean(editEntry), editedByManager: editEntry?.actor_name === "Manager One" };
});

scenario("UOM list is seeded and includes Pcs/Lusin", async (d) => {
  const rep = await loginCached(d, "rep@test.local", "password123");
  const listed = await d.api("GET", "/api/catalog/uom", { session: rep });
  const names = (listed.json.options as { name: string }[]).map((o) => o.name).sort();
  return { status: listed.status, hasPcs: names.includes("Pcs"), hasLusin: names.includes("Lusin") };
});

scenario("a rep cannot add a new UOM (403)", async (d) => {
  const rep = await loginCached(d, "rep@test.local", "password123");
  const added = await d.api("POST", "/api/catalog/uom", { body: { name: "Krat" }, session: rep });
  return { status: added.status };
});

scenario("a manager can add a new UOM, and it then appears in the list", async (d) => {
  const manager = await loginCached(d, "manager@test.local", "password123");
  const added = await d.api("POST", "/api/catalog/uom", { body: { name: "Karung" }, session: manager });
  const listed = await d.api("GET", "/api/catalog/uom", { session: manager });
  const names = (listed.json.options as { name: string }[]).map((o) => o.name);
  return { addStatus: added.status, nowInList: names.includes("Karung") };
});

scenario("adding a duplicate UOM name is rejected -> 409", async (d) => {
  const manager = await loginCached(d, "manager@test.local", "password123");
  const dup = await d.api("POST", "/api/catalog/uom", { body: { name: "Pcs" }, session: manager });
  return { status: dup.status };
});

// --- Per-item unit ratios (catalog_item_uoms) ---

const unitsOf = async (d: Driver, session: Session, codes: string[]) =>
  (await d.api("POST", "/api/catalog/units", { body: { codes }, session })).json.units;

scenario("import stores per-item units, cleaned (base dropped, case-insensitive dedup)", async (d) => {
  const manager = await loginCached(d, "manager@test.local", "password123");
  const imp = await d.api("POST", "/api/catalog/import", {
    body: {
      rows: [
        {
          code: "U-SMB", name: "Sambal 275ml", uom: "BTL", cogs: 12000,
          units: [{ uom: "BOX", factor: 24 }, { uom: "Box", factor: 12 }, { uom: "btl", factor: 1 }],
        },
        { code: "U-PEN", name: "Pulpen", uom: "Pcs", cogs: 1000 },
      ],
      mode: "merge",
    },
    session: manager,
  });
  const list = await d.api("GET", "/api/catalog?q=U-", { session: manager });
  const listed = Object.fromEntries(
    (list.json.items as { code: string; units: unknown }[]).map((i) => [i.code, i.units]),
  );
  const lookup = await unitsOf(d, manager, ["U-SMB", "U-PEN", "NOT-IN-CATALOG"]);
  assert.deepEqual(lookup, {
    "U-SMB": { baseUom: "BTL", units: [{ uom: "BOX", factor: 24 }] },
    "U-PEN": { baseUom: "Pcs", units: [] },
  });
  assert.deepEqual(listed["U-SMB"], [{ uom: "BOX", factor: 24 }]);
  return { status: imp.status, listed, lookup };
});

scenario("a rep can look up units but not import them", async (d) => {
  const rep = await loginCached(d, "rep@test.local", "password123");
  const imp = await d.api("POST", "/api/catalog/import", {
    body: { rows: [{ code: "U-REP", name: "X", units: [{ uom: "Box", factor: 2 }] }] },
    session: rep,
  });
  const lookup = await d.api("POST", "/api/catalog/units", { body: { codes: ["U-SMB"] }, session: rep });
  assert.equal(imp.status, 403);
  assert.equal(lookup.status, 200);
  return { importStatus: imp.status, lookupStatus: lookup.status };
});

scenario("import without units leaves existing units alone; an empty list clears them", async (d) => {
  const manager = await loginCached(d, "manager@test.local", "password123");
  await d.api("POST", "/api/catalog/import", {
    body: { rows: [{ code: "U-KEEP", name: "Keep", uom: "Pcs", units: [{ uom: "Lusin", factor: 12 }] }] },
    session: manager,
  });
  await d.api("POST", "/api/catalog/import", {
    body: { rows: [{ code: "U-KEEP", name: "Keep", cogs: 500 }] },
    session: manager,
  });
  const afterNoUnits = await unitsOf(d, manager, ["U-KEEP"]);
  await d.api("POST", "/api/catalog/import", {
    body: { rows: [{ code: "U-KEEP", name: "Keep", units: [] }] },
    session: manager,
  });
  const afterEmpty = await unitsOf(d, manager, ["U-KEEP"]);
  assert.deepEqual(afterNoUnits["U-KEEP"].units, [{ uom: "Lusin", factor: 12 }]);
  assert.deepEqual(afterEmpty["U-KEEP"].units, []);
  return { afterNoUnits, afterEmpty };
});

scenario("a units entry equal to the existing base is dropped even when the row sends no uom", async (d) => {
  const manager = await loginCached(d, "manager@test.local", "password123");
  await d.api("POST", "/api/catalog/import", {
    body: { rows: [{ code: "U-BASE", name: "Base", uom: "Rim" }] },
    session: manager,
  });
  await d.api("POST", "/api/catalog/import", {
    body: { rows: [{ code: "U-BASE", name: "Base", units: [{ uom: "RIM", factor: 1 }, { uom: "Box", factor: 5 }] }] },
    session: manager,
  });
  const units = await unitsOf(d, manager, ["U-BASE"]);
  assert.deepEqual(units["U-BASE"], { baseUom: "Rim", units: [{ uom: "Box", factor: 5 }] });
  return { units };
});

scenario("editing an item replaces its units; bad ratios are rejected (400)", async (d) => {
  const manager = await loginCached(d, "manager@test.local", "password123");
  const rep = await loginCached(d, "rep@test.local", "password123");
  const list = await d.api("GET", "/api/catalog?q=U-PEN", { session: manager });
  const id = list.json.items[0].id;
  const body = { name: "Pulpen", uom: "Pcs", cogs: 1000, list_price: 1500, category: "" };
  const ok = await d.api("PUT", `/api/catalog/${id}`, {
    body: { ...body, units: [{ uom: "Box", factor: 24 }, { uom: "Lusin", factor: 12 }] },
    session: manager,
  });
  const bad = await d.api("PUT", `/api/catalog/${id}`, {
    body: { ...body, units: [{ uom: "Box", factor: 0 }] },
    session: manager,
  });
  const repEdit = await d.api("PUT", `/api/catalog/${id}`, {
    body: { ...body, units: [{ uom: "Box", factor: 99 }] },
    session: rep,
  });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json.item.units, [{ uom: "Lusin", factor: 12 }, { uom: "Box", factor: 24 }]);
  assert.equal(bad.status, 400);
  assert.equal(repEdit.status, 403);
  return {
    okStatus: ok.status,
    returnedUnits: ok.json.item.units,
    badStatus: bad.status,
    repStatus: repEdit.status,
    stored: await unitsOf(d, manager, ["U-PEN"]),
  };
});

scenario("a quote line's priceUom survives save and reload", async (d) => {
  const rep = await loginCached(d, "rep@test.local", "password123");
  const quote = await createDraft(d, rep, [cleanItem({ uom: "Box", priceUom: "rim" })]);
  const detail = await d.api("GET", `/api/quotes/${quote.id}`, { session: rep });
  assert.equal(detail.json.quote.items[0].priceUom, "rim");
  return { priceUom: detail.json.quote.items[0].priceUom, uom: detail.json.quote.items[0].uom };
});

scenario("replace-mode import clears every item's units", async (d) => {
  const manager = await loginCached(d, "manager@test.local", "password123");
  await d.api("POST", "/api/catalog/import", {
    body: { rows: [{ code: "U-NEW", name: "Fresh", uom: "Pcs" }], mode: "replace" },
    session: manager,
  });
  const units = await unitsOf(d, manager, ["U-SMB", "U-PEN", "U-NEW"]);
  assert.deepEqual(units, { "U-NEW": { baseUom: "Pcs", units: [] } });
  const leftover = await d.api("POST", "/api/catalog/import", {
    body: { rows: [{ code: "U-SMB", name: "Sambal again", uom: "BTL" }] },
    session: manager,
  });
  assert.equal(leftover.status, 200);
  assert.deepEqual((await unitsOf(d, manager, ["U-SMB"]))["U-SMB"].units, []);
  return { units };
});

scenario('"mine" filter includes quotes reassigned to the viewer, not just ones they created', async (d) => {
  const manager = await loginCached(d, "manager@test.local", "password123");
  const rep = await loginCached(d, "rep@test.local", "password123");
  const rep2 = await loginCached(d, "rep2@test.local", "password123");
  const quote = await createDraft(d, rep, [cleanItem()]);
  const rep2User = await d.api("GET", "/api/auth/me", { session: rep2 });
  await d.api("POST", `/api/quotes/${quote.id}/reassign`, {
    body: { assigned_to: rep2User.json.user.id, note: "" },
    session: manager,
  });
  const mineList = await d.api("GET", "/api/quotes?mine=1", { session: rep2 });
  return {
    status: mineList.status,
    includesReassignedQuote: mineList.json.quotes.some((q: { id: number }) => q.id === quote.id),
  };
});

scenario("restoring a revision tags it restore-<client>-<n> and keeps the prior state", async (d) => {
  const rep = await loginCached(d, "rep@test.local", "password123");
  const quote = await createDraft(d, rep, [cleanItem()]);
  const saved = await d.api("POST", `/api/quotes/${quote.id}/revisions`, {
    body: { note: "Snapshot V1" },
    session: rep,
  });
  const detailBefore = await d.api("GET", `/api/quotes/${quote.id}`, { session: rep });
  const snapshotRev = detailBefore.json.revisions.find((r: { note: string }) => r.note === "Snapshot V1");
  await d.api("PUT", `/api/quotes/${quote.id}`, {
    body: { snapshot: snapshotFor([cleanItem({ qty: 700 })]), expected_version: quote.version },
    session: rep,
  });
  const restored = await d.api("POST", `/api/quotes/${quote.id}/restore/${snapshotRev.id}`, { session: rep });
  const detailAfter = await d.api("GET", `/api/quotes/${quote.id}`, { session: rep });
  const notes = detailAfter.json.revisions.map((r: { note: string }) => r.note);
  return {
    restoreStatus: restored.status,
    restoredQty: restored.json.quote.items[0].qty,
    restoreCount: restored.json.quote.restore_count,
    hasTaggedRevision: notes.some((n: string) => /^restore-.+-1$/.test(n)),
    hasPreRestoreSnapshot: notes.some((n: string) => n.startsWith("Sebelum restore-")),
  };
});

// ----------- revision authorization regression (security fix) -----------

scenario("creator can save a revision on own draft -> 201 and history records it", async (d) => {
  const rep = await loginCached(d, "rep@test.local", "password123");
  const quote = await createDraft(d, rep, [cleanItem()]);
  const saved = await d.api("POST", `/api/quotes/${quote.id}/revisions`, {
    body: { note: "Snapshot manual" },
    session: rep,
  });
  const detail = await d.api("GET", `/api/quotes/${quote.id}`, { session: rep });
  const hasRevision = detail.json.revisions.some((r: { note: string }) => r.note === "Snapshot manual");
  const hasAudit = detail.json.audit.some((a: { action: string }) => a.action === "revision_saved");
  return { status: saved.status, hasRevision, hasAudit };
});

scenario("a different rep cannot save a revision to another user's draft (403) and creates no revision/audit", async (d) => {
  const rep = await loginCached(d, "rep@test.local", "password123");
  const rep2 = await loginCached(d, "rep2@test.local", "password123");
  const quote = await createDraft(d, rep, [cleanItem()]);
  const before = await d.api("GET", `/api/quotes/${quote.id}`, { session: rep });
  const beforeRev = before.json.revisions.length;
  const beforeAudit = before.json.audit.length;
  const attempt = await d.api("POST", `/api/quotes/${quote.id}/revisions`, {
    body: { note: "Hijack attempt" },
    session: rep2,
  });
  const after = await d.api("GET", `/api/quotes/${quote.id}`, { session: rep });
  return {
    status: attempt.status,
    revUnchanged: beforeRev === after.json.revisions.length,
    auditUnchanged: beforeAudit === after.json.audit.length,
  };
});

scenario("assignee CAN save a revision after being reassigned", async (d) => {
  const rep = await loginCached(d, "rep@test.local", "password123");
  const rep2 = await loginCached(d, "rep2@test.local", "password123");
  const manager = await loginCached(d, "manager@test.local", "password123");
  const quote = await createDraft(d, rep, [cleanItem()]);
  const rep2User = await d.api("GET", "/api/auth/me", { session: rep2 });
  await d.api("POST", `/api/quotes/${quote.id}/reassign`, {
    body: { assigned_to: rep2User.json.user.id, note: "" },
    session: manager,
  });
  const saved = await d.api("POST", `/api/quotes/${quote.id}/revisions`, {
    body: { note: "Assignee snapshot" },
    session: rep2,
  });
  const detail = await d.api("GET", `/api/quotes/${quote.id}`, { session: rep2 });
  return {
    status: saved.status,
    hasRevision: detail.json.revisions.some((r: { note: string }) => r.note === "Assignee snapshot"),
  };
});

scenario("a manager (edit_all_quotes) CAN save a revision to another user's draft", async (d) => {
  const rep = await loginCached(d, "rep@test.local", "password123");
  const manager = await loginCached(d, "manager@test.local", "password123");
  const quote = await createDraft(d, rep, [cleanItem()]);
  const saved = await d.api("POST", `/api/quotes/${quote.id}/revisions`, {
    body: { note: "Manager snapshot" },
    session: manager,
  });
  const detail = await d.api("GET", `/api/quotes/${quote.id}`, { session: rep });
  return {
    status: saved.status,
    hasRevision: detail.json.revisions.some((r: { note: string }) => r.note === "Manager snapshot"),
  };
});

scenario("saving a revision on a submitted quote -> 409, no side effects", async (d) => {
  const rep = await loginCached(d, "rep@test.local", "password123");
  const quote = await createDraft(d, rep, [cleanItem()]);
  await d.api("POST", `/api/quotes/${quote.id}/submit`, { session: rep });
  const before = await d.api("GET", `/api/quotes/${quote.id}`, { session: rep });
  const beforeRev = before.json.revisions.length;
  const beforeAudit = before.json.audit.length;
  const attempt = await d.api("POST", `/api/quotes/${quote.id}/revisions`, {
    body: { note: "Should fail locked" },
    session: rep,
  });
  const after = await d.api("GET", `/api/quotes/${quote.id}`, { session: rep });
  return {
    status: attempt.status,
    revUnchanged: beforeRev === after.json.revisions.length,
    auditUnchanged: beforeAudit === after.json.audit.length,
  };
});

scenario("saving a revision on an approved quote -> 409 even for a manager (locked)", async (d) => {
  const manager = await loginCached(d, "manager@test.local", "password123");
  const quote = await createDraft(d, manager, [cleanItem()]);
  await d.api("POST", `/api/quotes/${quote.id}/submit`, { session: manager }); // auto-approves
  const before = await d.api("GET", `/api/quotes/${quote.id}`, { session: manager });
  const attempt = await d.api("POST", `/api/quotes/${quote.id}/revisions`, {
    body: { note: "Should fail approved" },
    session: manager,
  });
  const after = await d.api("GET", `/api/quotes/${quote.id}`, { session: manager });
  return {
    status: attempt.status,
    quoteStatus: before.json.quote.status,
    revUnchanged: before.json.revisions.length === after.json.revisions.length,
  };
});

scenario("saving a revision on a rejected quote is allowed (draft/rejected are editable)", async (d) => {
  const rep = await loginCached(d, "rep@test.local", "password123");
  const manager = await loginCached(d, "manager@test.local", "password123");
  const quote = await createDraft(d, rep, [cleanItem()], { targetMargin: 0.05, leaderMargin: 0.0 });
  await d.api("POST", `/api/quotes/${quote.id}/submit`, { session: rep });
  const decided = await d.api("POST", `/api/quotes/${quote.id}/decide`, {
    body: { decision: "rejected", note: "Margin terlalu tipis." },
    session: manager,
  });
  const saved = await d.api("POST", `/api/quotes/${quote.id}/revisions`, {
    body: { note: "Fix after rejection" },
    session: rep,
  });
  const detail = await d.api("GET", `/api/quotes/${quote.id}`, { session: rep });
  return {
    decideStatus: decided.status,
    saveStatus: saved.status,
    hasRevision: detail.json.revisions.some((r: { note: string }) => r.note === "Fix after rejection"),
  };
});

scenario("a different rep still cannot save a revision on a rejected quote they do not own (403)", async (d) => {
  const rep = await loginCached(d, "rep@test.local", "password123");
  const rep2 = await loginCached(d, "rep2@test.local", "password123");
  const manager = await loginCached(d, "manager@test.local", "password123");
  const quote = await createDraft(d, rep, [cleanItem()], { targetMargin: 0.05, leaderMargin: 0.0 });
  await d.api("POST", `/api/quotes/${quote.id}/submit`, { session: rep });
  await d.api("POST", `/api/quotes/${quote.id}/decide`, {
    body: { decision: "rejected", note: "Perlu revisi" },
    session: manager,
  });
  const before = await d.api("GET", `/api/quotes/${quote.id}`, { session: rep });
  const attempt = await d.api("POST", `/api/quotes/${quote.id}/revisions`, {
    body: { note: "Hijack rejected" },
    session: rep2,
  });
  const after = await d.api("GET", `/api/quotes/${quote.id}`, { session: rep });
  return {
    status: attempt.status,
    revUnchanged: before.json.revisions.length === after.json.revisions.length,
  };
});


// ---------------------------------------------------------------
// Client list -> quote: catalog matching and learned aliases.
// ---------------------------------------------------------------

const M_ROWS = [
  { code: "M-STB-OR", name: "STABILO BOSS HIGHLIGHTER ANTI DRY OUT ORANGE", uom: "Pcs", cogs: 9000, list_price: 12500 },
  { code: "M-STB-GR", name: "STABILO BOSS HIGHLIGHTER ANTI DRY OUT GREEN", uom: "Pcs", cogs: 9000, list_price: 12500 },
  { code: "M-BD70", name: "BOLA DUNIA KERTAS A4 70GR", uom: "Rim", cogs: 41000, list_price: 52000 },
  {
    code: "M-PEN", name: "STANDARD PULPEN TECNO BLACK 0.38MM", uom: "Pcs", cogs: 2000, list_price: 3000,
    units: [{ uom: "Box", factor: 12 }],
  },
];

async function seedMatchCatalog(d: Driver) {
  const manager = await loginCached(d, "manager@test.local", "password123");
  const imp = await d.api("POST", "/api/catalog/import", { body: { rows: M_ROWS, mode: "merge" }, session: manager });
  assert.equal(imp.status, 200, JSON.stringify(imp.json));
}

/** Results reduced to codes (ids differ between backends' databases). */
function codesOf(json: any) {
  const codeOf = new Map((json.items as { id: number; code: string }[]).map((i) => [i.id, i.code]));
  return (json.results as any[]).map((r) => ({
    status: r.status,
    via: r.via,
    best: r.candidates[0] ? codeOf.get(r.candidates[0].id) : null,
  }));
}

scenario("match: code, name similarity, brand mismatch and nothing-found, with catalog prices and units", async (d) => {
  await seedMatchCatalog(d);
  // A manager: this checks the catalog COGS, which staff no longer receive (PE-1).
  const rep = await loginCached(d, "manager@test.local", "password123");
  const res = await d.api("POST", "/api/catalog/match", {
    body: {
      lines: [
        { code: "m-pen", name: "pulpen", qty: 3, uom: "Box" },
        { name: "Stabilo boss highlighter orange", qty: 10 },
        { name: "Kertas A4 70gsm Sinar Dunia", qty: 50 },
        { name: "Galon air mineral 19 liter", qty: 2 },
      ],
    },
    session: rep,
  });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const results = codesOf(res.json);
  assert.deepEqual(results, [
    { status: "exact", via: "code", best: "M-PEN" },
    { status: "match", via: "name", best: "M-STB-OR" },
    { status: "review", via: "name", best: "M-BD70" },
    { status: "none", via: null, best: results[3].best },
  ]);
  const pen = (res.json.items as any[]).find((i) => i.code === "M-PEN");
  assert.deepEqual(
    { cogs: pen.cogs, list_price: pen.list_price, units: pen.units },
    { cogs: 2000, list_price: 3000, units: [{ uom: "Box", factor: 12 }] },
  );
  return { status: res.status, results, summary: res.json.summary, pen: { cogs: pen.cogs, units: pen.units } };
});

scenario("a confirmed alias is used for that client's next list, and not for another client's", async (d) => {
  await seedMatchCatalog(d);
  const rep = await loginCached(d, "rep@test.local", "password123");
  const a = await d.api("POST", "/api/clients", { body: { name: "PT Alias Satu" }, session: rep });
  const b = await d.api("POST", "/api/clients", { body: { name: "PT Alias Dua" }, session: rep });
  const clientA = a.json.client.id;
  const clientB = b.json.client.id;

  const save = await d.api("POST", "/api/catalog/aliases", {
    body: { client_id: clientA, pairs: [{ text: "Kertas  fotokopi  biasa", code: "m-bd70" }] },
    session: rep,
  });
  const lines = [{ name: "kertas fotokopi biasa", qty: 5 }];
  const forA = await d.api("POST", "/api/catalog/match", { body: { client_id: clientA, lines }, session: rep });
  const forB = await d.api("POST", "/api/catalog/match", { body: { client_id: clientB, lines }, session: rep });
  const noClient = await d.api("POST", "/api/catalog/match", { body: { lines }, session: rep });

  assert.equal(save.status, 200);
  assert.deepEqual(codesOf(forA.json)[0], { status: "exact", via: "alias", best: "M-BD70" });
  assert.notEqual(codesOf(forB.json)[0].via, "alias");
  assert.notEqual(codesOf(noClient.json)[0].via, "alias");

  // A global alias (no client) applies to everyone, but A's own still wins for A.
  const manager = await loginCached(d, "manager@test.local", "password123");
  await d.api("POST", "/api/catalog/aliases", {
    body: { pairs: [{ text: "kertas fotokopi biasa", code: "M-STB-GR" }] },
    session: manager,
  });
  const forA2 = await d.api("POST", "/api/catalog/match", { body: { client_id: clientA, lines }, session: rep });
  const forB2 = await d.api("POST", "/api/catalog/match", { body: { client_id: clientB, lines }, session: rep });
  assert.equal(codesOf(forA2.json)[0].best, "M-BD70");
  assert.deepEqual(codesOf(forB2.json)[0], { status: "exact", via: "alias", best: "M-STB-GR" });

  return {
    save: save.json,
    forA: codesOf(forA.json),
    forB: codesOf(forB.json)[0].via,
    forA2: codesOf(forA2.json),
    forB2: codesOf(forB2.json),
  };
});

// Regression: any rep could save an alias with no client. It is stored for
// every client and matches as "exact" (no review), so one rep's pairing would
// silently decide other reps' quotes for all clients.
scenario("only a manager may save an alias for every client; a rep must pick a client", async (d) => {
  await seedMatchCatalog(d);
  const rep = await loginCached(d, "rep@test.local", "password123");
  const manager = await loginCached(d, "manager@test.local", "password123");
  const c = await d.api("POST", "/api/clients", { body: { name: "PT Alias Tiga" }, session: rep });
  const other = await d.api("POST", "/api/clients", { body: { name: "PT Alias Empat" }, session: rep });
  const pairs = [{ text: "pulpen kantor", code: "M-PEN" }];
  const lines = [{ name: "pulpen kantor", qty: 1 }];

  const repGlobal = await d.api("POST", "/api/catalog/aliases", { body: { pairs }, session: rep });
  const afterRep = await d.api("POST", "/api/catalog/match", { body: { client_id: other.json.client.id, lines }, session: rep });
  const repClient = await d.api("POST", "/api/catalog/aliases", { body: { client_id: c.json.client.id, pairs }, session: rep });
  const mgrGlobal = await d.api("POST", "/api/catalog/aliases", { body: { pairs }, session: manager });
  const afterMgr = await d.api("POST", "/api/catalog/match", { body: { client_id: other.json.client.id, lines }, session: rep });

  assert.equal(repGlobal.status, 403);
  assert.notEqual(codesOf(afterRep.json)[0].via, "alias");
  assert.equal(repClient.status, 200);
  assert.equal(mgrGlobal.status, 200);
  assert.deepEqual(codesOf(afterMgr.json)[0], { status: "exact", via: "alias", best: "M-PEN" });
  return { repGlobal: repGlobal.status, repClient: repClient.status, mgrGlobal: mgrGlobal.status, afterMgr: codesOf(afterMgr.json)[0] };
});

scenario("an alias to a code not in the catalog, or for an unknown client, is rejected (400) and not stored", async (d) => {
  await seedMatchCatalog(d);
  const rep = await loginCached(d, "rep@test.local", "password123");
  const manager = await loginCached(d, "manager@test.local", "password123");
  const badCode = await d.api("POST", "/api/catalog/aliases", {
    body: { pairs: [{ text: "barang hantu", code: "NOPE-404" }, { text: "pulpen tecno", code: "M-PEN" }] },
    session: manager,
  });
  const badClient = await d.api("POST", "/api/catalog/aliases", {
    body: { client_id: 999999, pairs: [{ text: "pulpen tecno", code: "M-PEN" }] },
    session: rep,
  });
  // Neither request stored the valid pair either.
  const after = await d.api("POST", "/api/catalog/match", { body: { lines: [{ name: "pulpen tecno" }] }, session: rep });
  assert.equal(badCode.status, 400);
  assert.equal(badClient.status, 400);
  assert.notEqual(codesOf(after.json)[0].via, "alias");
  return { badCode: badCode.status, badClient: badClient.status, via: codesOf(after.json)[0].via };
});

scenario("match rejects an empty list, an over-long list, and requires login", async (d) => {
  const rep = await loginCached(d, "rep@test.local", "password123");
  const empty = await d.api("POST", "/api/catalog/match", { body: { lines: [] }, session: rep });
  const tooMany = await d.api("POST", "/api/catalog/match", {
    body: { lines: Array.from({ length: 501 }, (_, i) => ({ name: `item ${i}` })) },
    session: rep,
  });
  const anon = await d.api("POST", "/api/catalog/match", { body: { lines: [{ name: "x" }] } });
  const anonAlias = await d.api("POST", "/api/catalog/aliases", { body: { pairs: [{ text: "x", code: "M-PEN" }] } });
  assert.equal(empty.status, 400);
  assert.equal(tooMany.status, 400);
  assert.equal(anon.status, 401);
  assert.equal(anonAlias.status, 401);
  return { empty: empty.status, tooMany: tooMany.status, anon: anon.status, anonAlias: anonAlias.status };
});


// ---------------------------------------------------------------
// Term of payment and warranty (meeting 2026-10-05): required to submit.
// ---------------------------------------------------------------

scenario("submitting without term of payment / warranty -> 400 naming both, quote stays draft", async (d) => {
  // A manager: the snapshot carries an off-catalog line, which only managers may save (PE-1).
  const rep = await loginCached(d, "manager@test.local", "password123");
  const snap = snapshotFor([cleanItem()]);
  const created = await d.api("POST", "/api/quotes", {
    body: { title: "No terms", snapshot: { ...snap, meta: { ...snap.meta, paymentDays: null, warrantyYears: null } } },
    session: rep,
  });
  const submit = await d.api("POST", `/api/quotes/${created.json.quote.id}/submit`, { session: rep });
  const after = await d.api("GET", `/api/quotes/${created.json.quote.id}`, { session: rep });
  assert.equal(submit.status, 400);
  assert.deepEqual(submit.json.missing, ["Term of payment (hari)", "Garansi (tahun)"]);
  assert.equal(after.json.quote.status, "draft");
  return { status: submit.status, missing: submit.json.missing, after: after.json.quote.status };
});

scenario("warranty 0 (none) and payment 0 (cash) count as filled in", async (d) => {
  // A manager: the snapshot carries an off-catalog line, which only managers may save (PE-1).
  const rep = await loginCached(d, "manager@test.local", "password123");
  const snap = snapshotFor([cleanItem()]);
  const created = await d.api("POST", "/api/quotes", {
    body: { title: "Cash, no warranty", snapshot: { ...snap, meta: { ...snap.meta, paymentDays: 0, warrantyYears: 0 } } },
    session: rep,
  });
  const submit = await d.api("POST", `/api/quotes/${created.json.quote.id}/submit`, { session: rep });
  assert.equal(submit.status, 200, JSON.stringify(submit.json));
  return { status: submit.status, quoteStatus: submit.json.quote.status };
});

scenario("a new quote takes payment days from the client's terms; warranty starts empty", async (d) => {
  const rep = await loginCached(d, "rep@test.local", "password123");
  const client = await d.api("POST", "/api/clients", {
    body: { name: "PT Termin 45", payment_terms: "45 hari setelah invoice diterima" },
    session: rep,
  });
  const created = await d.api("POST", "/api/quotes", {
    body: { title: "Default terms", client_id: client.json.client.id },
    session: rep,
  });
  const meta = created.json.quote.meta;
  assert.equal(meta.paymentDays, 45);
  assert.equal(meta.payment, "setelah invoice diterima");
  assert.equal(meta.warrantyYears, null);
  return { paymentDays: meta.paymentDays, payment: meta.payment, warrantyYears: meta.warrantyYears };
});

scenario("warranty must be a whole or half year, payment days 0-365 -> else 400", async (d) => {
  // A manager: the snapshot carries an off-catalog line, which only managers may save (PE-1).
  const rep = await loginCached(d, "manager@test.local", "password123");
  const snap = snapshotFor([cleanItem()]);
  const bad = async (meta: Record<string, unknown>) =>
    (await d.api("POST", "/api/quotes", { body: { title: "Bad", snapshot: { ...snap, meta: { ...snap.meta, ...meta } } }, session: rep }))
      .status;
  const result = {
    quarterYear: await bad({ warrantyYears: 0.25 }),
    negativeDays: await bad({ paymentDays: -1 }),
    tooManyDays: await bad({ paymentDays: 400 }),
    halfYear: await bad({ warrantyYears: 1.5 }),
  };
  assert.deepEqual(result, { quarterYear: 400, negativeDays: 400, tooManyDays: 400, halfYear: 201 });
  return result;
});


// ---------------------------------------------------------------
// COGS sanity (meeting 2026-10-05 point 6): a bad catalog COGS can't be sold.
// ---------------------------------------------------------------

async function importRows(d: Driver, rows: Record<string, unknown>[], mode: "merge" | "replace" = "merge") {
  const manager = await loginCached(d, "manager@test.local", "password123");
  const r = await d.api("POST", "/api/catalog/import", { body: { rows, mode }, session: manager });
  assert.equal(r.status, 200, JSON.stringify(r.json));
}
/** The COGS problem as a manager reads it (staff get a wording without amounts, PE-1). */
async function problemOf(d: Driver, code: string): Promise<string | null> {
  const manager = await loginCached(d, "manager@test.local", "password123");
  const r = await d.api("GET", `/api/catalog?q=${encodeURIComponent(code)}`, { session: manager });
  return (r.json.items as { code: string; cogs_problem: string | null }[]).find((i) => i.code === code)!.cogs_problem;
}

scenario("COGS reference: small moves follow it, a >50% jump is flagged, a manager's confirmation moves it", async (d) => {
  await importRows(d, [{ code: "C-JMP", name: "Jump item", cogs: 1000, list_price: 9000 }]);
  await importRows(d, [{ code: "C-JMP", name: "Jump item", cogs: 1100 }]);
  const small = await problemOf(d, "C-JMP");
  await importRows(d, [{ code: "C-JMP", name: "Jump item", cogs: 2500 }]);
  const jumped = await problemOf(d, "C-JMP");

  const rep = await loginCached(d, "rep@test.local", "password123");
  const manager = await loginCached(d, "manager@test.local", "password123");
  const list = await d.api("GET", "/api/catalog?q=C-JMP", { session: rep });
  const id = list.json.items[0].id;
  const repVerify = await d.api("POST", `/api/catalog/${id}/verify-cogs`, { session: rep });
  const mgrVerify = await d.api("POST", `/api/catalog/${id}/verify-cogs`, { session: manager });
  const afterVerify = await problemOf(d, "C-JMP");
  await importRows(d, [{ code: "C-JMP", name: "Jump item", cogs: 2600 }]);
  const smallAfterVerify = await problemOf(d, "C-JMP");
  await importRows(d, [{ code: "C-JMP", name: "Jump item", cogs: 5000 }]);
  const jumpedAgain = await problemOf(d, "C-JMP");

  assert.equal(small, null);
  assert.equal(jumped, "COGS Rp 2.500 berubah 127% dari COGS acuan Rp 1.100; perlu dicek manajer");
  assert.equal(repVerify.status, 403);
  assert.equal(mgrVerify.status, 200);
  assert.equal(afterVerify, null);
  assert.equal(smallAfterVerify, null);
  assert.match(jumpedAgain!, /dari COGS acuan Rp 2.600/);
  return { small, jumped, repVerify: repVerify.status, mgrVerify: mgrVerify.json, afterVerify, smallAfterVerify, jumpedAgain };
});

// Regression: with "average of history", the jumped value itself entered the
// baseline, so re-importing the same file (or nudging it) cleared the flag
// with nobody having checked anything.
scenario("a flagged jump stays flagged when the same file is replace-imported again", async (d) => {
  await importRows(d, [{ code: "C-RPL", name: "Replaced", cogs: 1000, list_price: 9000 }]);
  await importRows(d, [{ code: "C-RPL", name: "Replaced", cogs: 2000, list_price: 9000 }], "replace");
  const once = await problemOf(d, "C-RPL");
  await importRows(d, [{ code: "C-RPL", name: "Replaced", cogs: 2000, list_price: 9000 }], "replace");
  const twice = await problemOf(d, "C-RPL");
  assert.equal(once, "COGS Rp 2.000 berubah 100% dari COGS acuan Rp 1.000; perlu dicek manajer");
  assert.equal(twice, once);
  return { once, twice };
});

scenario("a flagged jump stays flagged after a further small change", async (d) => {
  await importRows(d, [{ code: "C-CRP", name: "Creep", cogs: 1000, list_price: 9000 }]);
  await importRows(d, [{ code: "C-CRP", name: "Creep", cogs: 2000 }]);
  await importRows(d, [{ code: "C-CRP", name: "Creep", cogs: 2100 }]);
  const problem = await problemOf(d, "C-CRP");
  assert.equal(problem, "COGS Rp 2.100 berubah 110% dari COGS acuan Rp 1.000; perlu dicek manajer");
  return { problem };
});

scenario("submitting a quote with a bad-COGS catalog item -> 400 naming the line; fixed catalog -> submits", async (d) => {
  await importRows(d, [{ code: "C-BAD", name: "COGS above list", cogs: 5000, list_price: 4000 }]);
  const rep = await loginCached(d, "rep@test.local", "password123");
  // A rep quotes the catalog item by code; its COGS comes from the catalog (PE-1).
  const made = await d.api("POST", "/api/quotes", {
    body: { title: "Bad COGS", snapshot: { ...snapshotFor([]), items: [{ id: "b1", code: "C-BAD", qty: 1, rrp: 8000 }] } },
    session: rep,
  });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  const q = made.json.quote as { id: number };
  const blocked = await d.api("POST", `/api/quotes/${q.id}/submit`, { session: rep });
  const still = await d.api("GET", `/api/quotes/${q.id}`, { session: rep });
  await importRows(d, [{ code: "C-BAD", name: "COGS above list", list_price: 9000 }]);
  const ok = await d.api("POST", `/api/quotes/${q.id}/submit`, { session: rep });

  assert.equal(blocked.status, 400);
  assert.deepEqual(blocked.json.cogsBlocked.map((l: { code: string; lineNo: number }) => [l.code, l.lineNo]), [["C-BAD", 1]]);
  assert.equal(still.json.quote.status, "draft");
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  return { blocked: blocked.status, lines: blocked.json.cogsBlocked, status: still.json.quote.status, ok: ok.status };
});

// Regression: the check looked codes up exactly, so a line coded "c-case" or
// "C-CASE " (a client's file keeps the code as typed) skipped the block.
scenario("a bad-COGS item is blocked whatever the case or spacing of the line's code", async (d) => {
  await importRows(d, [{ code: "C-CASE", name: "COGS above list", cogs: 5000, list_price: 4000 }]);
  // A manager: staff lines are built from the catalog and always carry its spelling (PE-1).
  const rep = await loginCached(d, "manager@test.local", "password123");
  const submitWith = async (code: string) => {
    const q = await createDraft(d, rep, [cleanItem({ code, name: "COGS above list", cogs: 5000, rrp: 8000 })]);
    const r = await d.api("POST", `/api/quotes/${q.id}/submit`, { session: rep });
    return { status: r.status, lines: r.json.cogsBlocked?.map((l: { code: string }) => l.code) };
  };
  const lower = await submitWith("c-case");
  const spaced = await submitWith(" C-CASE ");
  const check = await d.api("POST", "/api/catalog/cogs-check", { body: { codes: ["c-case"] }, session: rep });

  assert.deepEqual(lower, { status: 400, lines: ["c-case"] });
  assert.deepEqual(spaced, { status: 400, lines: [" C-CASE "] });
  assert.deepEqual(Object.keys(check.json.problems), ["c-case"]);
  return { lower, spaced, check: check.json };
});

scenario("cogs-check reports only problem codes; empty COGS is a problem", async (d) => {
  await importRows(d, [
    { code: "C-OK", name: "Fine", cogs: 1000, list_price: 1500 },
    { code: "C-ZERO", name: "No cost", cogs: 0, list_price: 1500 },
  ]);
  const rep = await loginCached(d, "rep@test.local", "password123");
  const r = await d.api("POST", "/api/catalog/cogs-check", { body: { codes: ["C-OK", "C-ZERO", "C-BAD", "NOT-THERE"] }, session: rep });
  assert.deepEqual(Object.keys(r.json.problems).sort(), ["C-ZERO"]);
  return r.json;
});



// ---------------------------------------------------------------
// PE-1 (meeting 2026-10-05 #4): staff never receive cost data.
// A COGS of Rp 31.337 is unmistakable: if it (or a key that carries cost or
// margin) shows up in any response a rep gets, the rep can read it in DevTools.
// ---------------------------------------------------------------

const LEAK_COGS = 31337;
/** The leak marker in any spelling a response might use (raw, id-ID or en-US grouping). */
const LEAK_TEXT = /31337|31\.337|31,337/;
/**
 * Keys that carry cost or margin, at any depth, also inside a JSON string
 * (an audit entry's `detail` arrives as `\"net_margin\":`).
 */
const LEAK_KEY = /\\?"(cogs|landed|margin|margins|net_margin|netMargin|assumptions|manualPrice|lowestMargin|targetMargin|minNetMargin|minLineMargin)\\?"\s*:/;

function leaksIn(json: unknown): string[] {
  const text = JSON.stringify(json ?? null);
  const out: string[] = [];
  if (LEAK_TEXT.test(text)) out.push("cogs-value");
  const key = LEAK_KEY.exec(text);
  if (key) out.push(`key:${key[1]}`);
  return out;
}

/** Calls every endpoint on the PE-1 leak map as this user; returns endpoint -> what leaked. */
async function costExposure(d: Driver, session: Session) {
  const create = await d.api("POST", "/api/quotes", {
    body: {
      title: "Leak probe",
      snapshot: snapshotFor([cleanItem({ id: "lk1", code: "LEAK-1", name: "Barang bocor", cogs: LEAK_COGS, rrp: 99000, qty: 2 })]),
    },
    session,
  });
  const id = create.json.quote?.id;
  const bad = await d.api("POST", "/api/quotes", {
    body: {
      title: "Leak probe bad",
      snapshot: snapshotFor([cleanItem({ id: "lk3", code: "LEAK-3", name: "COGS di atas harga jual", cogs: LEAK_COGS, rrp: 99000 })]),
    },
    session,
  });
  const got = await d.api("GET", `/api/quotes/${id}`, { session });
  const put = await d.api("PUT", `/api/quotes/${id}`, {
    body: { snapshot: got.json.quote ? snapshotFor(got.json.quote.items ?? []) : {}, expected_version: got.json.quote?.version },
    session,
  });
  const stale = await d.api("PUT", `/api/quotes/${id}`, {
    body: { snapshot: got.json.quote ? snapshotFor(got.json.quote.items ?? []) : {}, expected_version: -1 },
    session,
  });
  const calls: Record<string, unknown> = {
    "POST /quotes": create.json,
    "GET /quotes/:id": got.json,
    "PUT /quotes/:id": put.json,
    "PUT /quotes/:id (stale version)": stale.json,
    "GET /quotes": (await d.api("GET", "/api/quotes", { session })).json,
    "POST submit (blocked)": (await d.api("POST", `/api/quotes/${bad.json.quote?.id}/submit`, { session })).json,
    "POST submit": (await d.api("POST", `/api/quotes/${id}/submit`, { session })).json,
    // The submit writes an audit entry; read the quote again to see it.
    "GET /quotes/:id (after submit)": (await d.api("GET", `/api/quotes/${id}`, { session })).json,
    "POST reopen": (await d.api("POST", `/api/quotes/${id}/reopen`, { session })).json,
    "POST revisions": (await d.api("POST", `/api/quotes/${id}/revisions`, { body: { note: "probe" }, session })).json,
  };
  const detail = (await d.api("GET", `/api/quotes/${id}`, { session })).json;
  calls["GET /quotes/:id (after reopen)"] = detail;
  const revisionId = detail.revisions?.[0]?.id;
  calls["POST restore"] = (await d.api("POST", `/api/quotes/${id}/restore/${revisionId}`, { session })).json;
  Object.assign(calls, {
    "GET /catalog": (await d.api("GET", "/api/catalog?q=LEAK", { session })).json,
    "POST /catalog/match": (await d.api("POST", "/api/catalog/match", { body: { lines: [{ name: "Barang bocor" }] }, session })).json,
    "POST /catalog/cogs-check": (await d.api("POST", "/api/catalog/cogs-check", { body: { codes: ["LEAK-1", "LEAK-3"] }, session })).json,
    "GET /settings": (await d.api("GET", "/api/settings", { session })).json,
    "POST /quotes/preview (new)": (await d.api("POST", "/api/quotes/preview", {
      body: { snapshot: { items: [{ id: "p1", code: "LEAK-1", qty: 1 }] } },
      session,
    })).json,
    "POST /quotes/preview (existing)": (await d.api("POST", "/api/quotes/preview", {
      body: { quote_id: id, snapshot: { items: [{ id: "p1", code: "LEAK-1", qty: 3 }] } },
      session,
    })).json,
  });
  const exposure: Record<string, string[]> = {};
  for (const [name, json] of Object.entries(calls)) {
    const l = leaksIn(json);
    if (l.length) exposure[name] = l;
  }
  return exposure;
}

async function seedLeakCatalog(d: Driver) {
  await importRows(d, [
    { code: "LEAK-1", name: "Barang bocor", cogs: LEAK_COGS, list_price: 99000 },
    { code: "LEAK-3", name: "COGS di atas harga jual", cogs: LEAK_COGS, list_price: 20000 },
  ]);
}

scenario("PE-1: a rep receives no COGS, landed cost or margin from any endpoint", async (d) => {
  await seedLeakCatalog(d);
  const rep = await loginCached(d, "rep@test.local", "password123");
  const exposure = await costExposure(d, rep);
  const assistant = await d.api("POST", "/api/assistant/ask", {
    body: { context: { snapshot: snapshotFor([cleanItem()]) }, messages: [{ role: "user", content: "x" }] },
    session: rep,
  });
  assert.deepEqual(exposure, {}, `cost data reaches a rep: ${JSON.stringify(exposure)}`);
  assert.equal(assistant.status, 403);
  return { exposure, assistant: assistant.status };
});

scenario("PE-1: a manager still sees cost data (the leak probe is not vacuous)", async (d) => {
  await seedLeakCatalog(d);
  const manager = await loginCached(d, "manager@test.local", "password123");
  const exposure = await costExposure(d, manager);
  for (const name of ["GET /quotes/:id", "GET /catalog", "POST /catalog/match"]) {
    assert.ok(exposure[name]?.includes("cogs-value"), `${name} should show the manager the COGS`);
  }
  return { sees: ["GET /quotes/:id", "GET /catalog", "POST /catalog/match"].map((n) => exposure[n]?.includes("cogs-value")) };
});

scenario("PE-1: COGS, role and manual price a rep sends are ignored; the catalog's COGS is kept", async (d) => {
  await seedLeakCatalog(d);
  const rep = await loginCached(d, "rep@test.local", "password123");
  const manager = await loginCached(d, "manager@test.local", "password123");
  const created = await d.api("POST", "/api/quotes", {
    body: {
      title: "Tamper",
      snapshot: snapshotFor([cleanItem({ id: "t1", code: "LEAK-1", name: "Barang bocor", cogs: 1, rrp: 99000, role: "LEADER", manualPrice: [5, 5, 5] })]),
    },
    session: rep,
  });
  const id = created.json.quote.id;
  // A save of the same line with tampered cost fields, then a revision saved
  // and restored: neither may get a cost from the browser into the quote.
  const v = (await d.api("GET", `/api/quotes/${id}`, { session: rep })).json.quote.version;
  const put = await d.api("PUT", `/api/quotes/${id}`, {
    body: {
      snapshot: { items: [{ id: "t1", code: "LEAK-1", qty: 4, cogs: 1, role: "PROFIT", manualPrice: [5, 5, 5] }] },
      expected_version: v,
    },
    session: rep,
  });
  await d.api("POST", `/api/quotes/${id}/revisions`, { body: { note: "tamper", snapshot: { items: [{ cogs: 1 }] } }, session: rep });
  const revs = (await d.api("GET", `/api/quotes/${id}`, { session: rep })).json.revisions;
  const restored = await d.api("POST", `/api/quotes/${id}/restore/${revs[0].id}`, { session: rep });
  const asManager = await d.api("GET", `/api/quotes/${id}`, { session: manager });
  const line = asManager.json.quote.items[0];
  assert.equal(put.status, 200, JSON.stringify(put.json));
  assert.equal(restored.status, 200, JSON.stringify(restored.json));
  assert.equal(line.cogs, LEAK_COGS);
  assert.equal(line.role, "CORE");
  assert.equal(line.manualPrice ?? null, null);
  assert.equal(line.qty, 4);
  return { cogs: line.cogs, role: line.role, manual: line.manualPrice ?? null, qty: line.qty };
});

scenario("PE-1: preview prices exactly what a save would, without saving", async (d) => {
  await seedLeakCatalog(d);
  const rep = await loginCached(d, "rep@test.local", "password123");
  const created = await d.api("POST", "/api/quotes", {
    body: { title: "Preview", snapshot: { ...snapshotFor([]), items: [{ id: "p1", code: "LEAK-1", qty: 2, rrp: 99000 }] } },
    session: rep,
  });
  const id = created.json.quote.id;
  const before = (await d.api("GET", `/api/quotes/${id}`, { session: rep })).json;
  const edit = { items: [{ id: "p1", code: "LEAK-1", qty: 7 }, { id: "p2", code: "LEAK-1", qty: 1, uom: "Pcs" }] };
  const preview = await d.api("POST", "/api/quotes/preview", { body: { quote_id: id, snapshot: edit }, session: rep });
  const after = (await d.api("GET", `/api/quotes/${id}`, { session: rep })).json;
  const saved = await d.api("PUT", `/api/quotes/${id}`, { body: { snapshot: edit, expected_version: before.quote.version }, session: rep });
  const outside = await d.api("POST", "/api/quotes/preview", {
    body: { snapshot: { items: [{ id: "x", code: "", name: "Barang lain", qty: 1 }] } },
    session: rep,
  });

  assert.equal(preview.status, 200, JSON.stringify(preview.json));
  assert.equal(after.quote.version, before.quote.version);
  assert.equal(after.audit.length, before.audit.length);
  assert.deepEqual(preview.json.quote.items, saved.json.quote.items);
  assert.deepEqual(preview.json.quote.pricing, saved.json.quote.pricing);
  assert.equal(outside.status, 400);
  return { prices: preview.json.quote.items.map((i: { price: number }) => i.price), total: preview.json.quote.pricing.total, outside: outside.status };
});


scenario("PE-1: sorting the catalog by COGS is ignored for staff (the order would rank costs)", async (d) => {
  await importRows(d, [
    { code: "SRT-A", name: "SRT Alpha", cogs: 3000, list_price: 9000 },
    { code: "SRT-B", name: "SRT Bravo", cogs: 1000, list_price: 9000 },
    { code: "SRT-C", name: "SRT Charlie", cogs: 2000, list_price: 9000 },
  ]);
  const order = async (email: string) => {
    const session = await loginCached(d, email, "password123");
    const r = await d.api("GET", "/api/catalog?q=SRT-&sortBy=cogs&sortDir=asc", { session });
    return (r.json.items as { code: string }[]).map((i) => i.code);
  };
  const rep = await order("rep@test.local");
  const manager = await order("manager@test.local");
  assert.deepEqual(rep, ["SRT-A", "SRT-B", "SRT-C"]);
  assert.deepEqual(manager, ["SRT-B", "SRT-C", "SRT-A"]);
  return { rep, manager };
});

// ---------------------------------------------------------------
// Run: ONE pair of backends for the whole run (Node caches the
// dynamically-imported server/db.js module by URL, so "fresh drivers
// per scenario" would silently share the first scenario's database
// instead of getting an isolated one — this single-setup shape avoids
// that entirely, and login-session caching keeps both sides under the
// real rate limiter). Every scenario appends more state (new quotes),
// but no scenario's extracted result depends on absolute ids/counts.
// ---------------------------------------------------------------

async function main() {
  const express = await makeExpressDriver();
  const worker = await makeWorkerDriver();
  for (const d of [express, worker]) {
    await d.seedUser("rep@test.local", "Rep One", "rep", "password123");
    await d.seedUser("manager@test.local", "Manager One", "manager", "password123");
    await d.seedUser("rep2@test.local", "Rep Two", "rep", "password123");
  }

  let passed = 0;
  const failures: { name: string; error: unknown }[] = [];

  for (const s of scenarios) {
    try {
      // allSettled, not all: if one backend fails, the other's run must still
      // finish before the next scenario starts, or its leftover writes leak
      // into that scenario and one failure shows up as several.
      const [e, w] = await Promise.allSettled([s.run(express), s.run(worker)]);
      if (e.status === "rejected") throw e.reason;
      if (w.status === "rejected") throw w.reason;
      const [expressResult, workerResult] = [e.value, w.value];
      assert.deepEqual(
        workerResult,
        expressResult,
        `parity mismatch\n  express: ${JSON.stringify(expressResult)}\n  worker:  ${JSON.stringify(workerResult)}`,
      );
      console.log(`  ok  ${s.name}`);
      passed++;
    } catch (error) {
      console.log(`FAIL  ${s.name}`);
      failures.push({ name: s.name, error });
    }
  }

  await express.teardown();
  await worker.teardown();

  console.log(`\n${passed}/${scenarios.length} passed.`);
  if (failures.length) {
    console.log("\nFailures:\n");
    for (const f of failures) {
      console.log(`- ${f.name}`);
      console.log(`  ${f.error instanceof Error ? f.error.message : String(f.error)}`);
    }
    process.exitCode = 1;
  }
}

main();
