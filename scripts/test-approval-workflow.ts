/* ============================================================
   Integration test for the submit -> approval decision workflow.
   Drives the Worker app (server/worker: auth + quotes + approvals
   routers, the same code production runs) over HTTP-shaped requests,
   on a D1 shim over node:sqlite with every migration applied, not a
   mock.

   Runs as a plain tsx script (not under Vitest): Vitest's bundled Vite
   doesn't recognize "node:sqlite" as a builtin (it strips the "node:"
   prefix and checks isBuiltin("sqlite"), which is false for this
   module), so it tries to resolve "sqlite" as a package and fails.

   Run: npx tsx scripts/test-approval-workflow.ts
   ============================================================ */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { AlwaysAllowRateLimit, D1DatabaseShim } from "./d1-sqlite-shim.js";

type Session = { cookie: string };

/** The app's own request entry, bound to its bindings (set in setup()). */
let request: (routePath: string, init: RequestInit) => Promise<Response>;

async function api(
  method: string,
  routePath: string,
  opts: { body?: unknown; session?: Session } = {},
) {
  const res = await request(routePath, {
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
  return { status: res.status, json, cookie };
}

async function login(email: string, password: string): Promise<Session> {
  const { status, cookie } = await api("POST", "/api/auth/login", {
    body: { email, password },
  });
  if (status !== 200 || !cookie) throw new Error(`login failed for ${email}: ${status}`);
  return { cookie };
}

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

/**
 * A draft owned by `session`. Staff can't send cost inputs or assumptions
 * (PE-1): their lines are priced from the catalog row seeded in setup(), and
 * a requested policy breach becomes a client ceiling just above cost, so the
 * price is capped there and the margin breaks the policy.
 */
async function createDraft(
  session: Session,
  items: ReturnType<typeof cleanItem>[],
  overAssumptions: Record<string, unknown> = {},
) {
  const isRep = session === repSession;
  const breach = isRep && Object.keys(overAssumptions).length > 0;
  const lines = breach ? items.map((it) => ({ ...it, rrp: Math.round(Number(it.cogs) * 1.1) })) : items;
  const created = await api("POST", "/api/quotes", {
    body: { title: "Test quote", snapshot: snapshotFor(lines, overAssumptions) },
    session,
  });
  assert.equal(created.status, 201, `create draft failed: ${JSON.stringify(created.json)}`);
  return created.json.quote as { id: number; version: number; number: string };
}

// ---------------------------------------------------------------
// Minimal test runner: sequential, first-class async, fails loud.
// ---------------------------------------------------------------
type TestCase = { name: string; fn: () => Promise<void> };
const tests: TestCase[] = [];
const test = (name: string, fn: () => Promise<void>) => tests.push({ name, fn });

let repSession: Session;
let managerSession: Session;
let rep2Session: Session;

async function setup() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = path.resolve(import.meta.dirname, "../migrations");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) sqlite.exec(readFileSync(path.join(dir, f), "utf8"));
  const db = new D1DatabaseShim(sqlite) as unknown as D1Database;

  const { Hono } = await import("hono");
  const { loadUser, hashPassword } = await import("../server/worker/auth.js");
  const { authRouter } = await import("../server/worker/routes/auth.js");
  const { quotesRouter } = await import("../server/worker/routes/quotes.js");
  const { approvalsRouter } = await import("../server/worker/routes/approvals.js");
  const { run } = await import("../server/db.d1.js");

  const app = new Hono();
  app.use(loadUser);
  app.route("/api/auth", authRouter);
  app.route("/api/quotes", quotesRouter);
  app.route("/api/approvals", approvalsRouter);
  const env = {
    DB: db,
    JWT_SECRET: "test-only-secret-not-for-production-0000000000",
    NODE_ENV: "test",
    AUTH_LIMITER: new AlwaysAllowRateLimit(),
    ASSISTANT_LIMITER: new AlwaysAllowRateLimit(),
  };
  // Notifications are fire-and-forget through waitUntil; nothing is configured to receive them.
  const executionCtx = {
    waitUntil: (p: Promise<unknown>) => void p.catch(() => undefined),
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext;
  request = async (routePath, init) => app.request(routePath, init, env, executionCtx);

  // The catalog row staff quote ATK-001 from: same cost and ceiling as cleanItem().
  await run(
    db,
    "INSERT INTO catalog_items(code, name, uom, cogs, list_price, stock, category, source) VALUES(?, ?, ?, ?, ?, 0, '', 'test')",
    "ATK-001",
    "Kertas A4 80gsm",
    "rim",
    38000,
    55000,
  );
  for (const [email, name, role] of [
    ["rep@test.local", "Rep One", "rep"],
    ["manager@test.local", "Manager One", "manager"],
    ["rep2@test.local", "Rep Two", "rep"],
  ]) {
    await run(db, "INSERT INTO users(email, name, password_hash, role) VALUES(?, ?, ?, ?)", email, name, await hashPassword("password123"), role);
  }

  // Login once per role and reuse the session, as a browser would.
  repSession = await login("rep@test.local", "password123");
  managerSession = await login("manager@test.local", "password123");
  rep2Session = await login("rep2@test.local", "password123");
}

async function teardown() {}

// ---------------------------------------------------------------
// Tests
// ---------------------------------------------------------------

test("rep submitting a clean quote goes to pending, not auto-approved", async () => {
  const rep = repSession;
  const quote = await createDraft(rep, [cleanItem()]);
  const submitted = await api("POST", `/api/quotes/${quote.id}/submit`, { session: rep });
  assert.equal(submitted.status, 200);
  assert.equal(submitted.json.autoApproved, false);
  assert.deepEqual(submitted.json.breaches, []);
  assert.equal(submitted.json.quote.status, "submitted");
});

test("manager submitting the same clean quote is auto-approved on the spot", async () => {
  const manager = managerSession;
  const quote = await createDraft(manager, [cleanItem()]);
  const submitted = await api("POST", `/api/quotes/${quote.id}/submit`, { session: manager });
  assert.equal(submitted.status, 200);
  assert.equal(submitted.json.autoApproved, true);
  assert.equal(submitted.json.quote.status, "approved");
  assert.notEqual(submitted.json.quote.approved_by, null);
});

test("rep submitting a policy-breaching quote goes to pending, told only that a manager must review", async () => {
  const rep = repSession;
  const quote = await createDraft(rep, [cleanItem()], { targetMargin: 0.05, leaderMargin: 0.0 });
  const submitted = await api("POST", `/api/quotes/${quote.id}/submit`, { session: rep });
  assert.equal(submitted.status, 200);
  assert.equal(submitted.json.autoApproved, false);
  assert.equal(submitted.json.quote.status, "submitted");
  assert.deepEqual(submitted.json.breaches.map((b: { code: string }) => b.code), ["NEEDS_REVIEW"]);
});

test("manager submitting a breaching quote does NOT get auto-approved despite the permission", async () => {
  const manager = managerSession;
  const quote = await createDraft(manager, [cleanItem()], { targetMargin: 0.05, leaderMargin: 0.0 });
  const submitted = await api("POST", `/api/quotes/${quote.id}/submit`, { session: manager });
  assert.equal(submitted.json.autoApproved, false);
  assert.equal(submitted.json.quote.status, "submitted");
});

test("submitting twice (already locked) is rejected with 409", async () => {
  const rep = repSession;
  const quote = await createDraft(rep, [cleanItem()]);
  await api("POST", `/api/quotes/${quote.id}/submit`, { session: rep });
  const again = await api("POST", `/api/quotes/${quote.id}/submit`, { session: rep });
  assert.equal(again.status, 409);
});

test("rep cannot decide (403), even on their own quote", async () => {
  const rep = repSession;
  const quote = await createDraft(rep, [cleanItem()], { targetMargin: 0.05, leaderMargin: 0.0 });
  await api("POST", `/api/quotes/${quote.id}/submit`, { session: rep });
  const decided = await api("POST", `/api/quotes/${quote.id}/decide`, {
    body: { decision: "approved", note: "" },
    session: rep,
  });
  assert.equal(decided.status, 403);
});

test("manager can approve a pending quote", async () => {
  const rep = repSession;
  const manager = managerSession;
  const quote = await createDraft(rep, [cleanItem()], { targetMargin: 0.05, leaderMargin: 0.0 });
  await api("POST", `/api/quotes/${quote.id}/submit`, { session: rep });
  const decided = await api("POST", `/api/quotes/${quote.id}/decide`, {
    body: { decision: "approved", note: "Dispensasi khusus" },
    session: manager,
  });
  assert.equal(decided.status, 200);
  assert.equal(decided.json.quote.status, "approved");
  assert.equal(decided.json.quote.decision_note, "Dispensasi khusus");
});

test("rejecting without a note is rejected with 400 (reason is mandatory)", async () => {
  const rep = repSession;
  const manager = managerSession;
  const quote = await createDraft(rep, [cleanItem()], { targetMargin: 0.05, leaderMargin: 0.0 });
  await api("POST", `/api/quotes/${quote.id}/submit`, { session: rep });
  const decided = await api("POST", `/api/quotes/${quote.id}/decide`, {
    body: { decision: "rejected", note: "" },
    session: manager,
  });
  assert.equal(decided.status, 400);
});

test("manager can reject with a note, and the quote is no longer locked as submitted", async () => {
  const rep = repSession;
  const manager = managerSession;
  const quote = await createDraft(rep, [cleanItem()], { targetMargin: 0.05, leaderMargin: 0.0 });
  await api("POST", `/api/quotes/${quote.id}/submit`, { session: rep });
  const decided = await api("POST", `/api/quotes/${quote.id}/decide`, {
    body: { decision: "rejected", note: "Margin terlalu tipis, revisi ulang." },
    session: manager,
  });
  assert.equal(decided.status, 200);
  assert.equal(decided.json.quote.status, "rejected");
});

test("deciding a quote that isn't pending returns 409", async () => {
  const manager = managerSession;
  const quote = await createDraft(manager, [cleanItem()]); // still draft, never submitted
  const decided = await api("POST", `/api/quotes/${quote.id}/decide`, {
    body: { decision: "approved", note: "" },
    session: manager,
  });
  assert.equal(decided.status, 409);
});

test("a save with a stale expected_version is rejected with 409 and does not overwrite", async () => {
  const rep = repSession;
  const quote = await createDraft(rep, [cleanItem()]);
  const staleVersion = quote.version;

  const firstSave = await api("PUT", `/api/quotes/${quote.id}`, {
    body: { snapshot: snapshotFor([cleanItem({ qty: 200 })]), expected_version: staleVersion },
    session: rep,
  });
  assert.equal(firstSave.status, 200);
  assert.equal(firstSave.json.quote.version, staleVersion + 1);

  const secondSave = await api("PUT", `/api/quotes/${quote.id}`, {
    body: { snapshot: snapshotFor([cleanItem({ qty: 300 })]), expected_version: staleVersion },
    session: rep,
  });
  assert.equal(secondSave.status, 409);
  assert.equal(secondSave.json.quote.items[0].qty, 200);
});

test("a save with the current expected_version succeeds and bumps the version", async () => {
  const rep = repSession;
  const quote = await createDraft(rep, [cleanItem()]);
  const saved = await api("PUT", `/api/quotes/${quote.id}`, {
    body: { snapshot: snapshotFor([cleanItem({ qty: 500 })]), expected_version: quote.version },
    session: rep,
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.quote.version, quote.version + 1);
  assert.equal(saved.json.quote.items[0].qty, 500);
});

test("a locked (submitted) quote cannot be edited at all, regardless of version", async () => {
  const rep = repSession;
  const quote = await createDraft(rep, [cleanItem()]);
  await api("POST", `/api/quotes/${quote.id}/submit`, { session: rep });
  const saved = await api("PUT", `/api/quotes/${quote.id}`, {
    body: { snapshot: snapshotFor([cleanItem({ qty: 999 })]), expected_version: quote.version },
    session: rep,
  });
  assert.equal(saved.status, 409);
});

test("a different rep cannot submit someone else's draft (403)", async () => {
  const rep = repSession;
  const rep2 = rep2Session;
  const quote = await createDraft(rep, [cleanItem()]);
  const submitted = await api("POST", `/api/quotes/${quote.id}/submit`, { session: rep2 });
  assert.equal(submitted.status, 403);
});

test("a manager CAN edit/submit another rep's draft (edit_all_quotes)", async () => {
  const rep = repSession;
  const manager = managerSession;
  const quote = await createDraft(rep, [cleanItem()]);
  const submitted = await api("POST", `/api/quotes/${quote.id}/submit`, { session: manager });
  assert.equal(submitted.status, 200);
});

test("10 concurrent creates by the same user all get distinct quote numbers", async () => {
  const rep = repSession;
  const results = await Promise.all(Array.from({ length: 10 }, () => createDraft(rep, [cleanItem()])));
  const numbers = results.map((q) => q.number);
  assert.equal(new Set(numbers).size, 10);
});

test("a rep cannot read the company-wide approval queue (403) — regression for the missing guard found in the 2026-09-19 security review", async () => {
  const rep = repSession;
  const listed = await api("GET", "/api/approvals?decision=pending", { session: rep });
  assert.equal(listed.status, 403);
});

test("a manager CAN read the approval queue", async () => {
  const manager = managerSession;
  const listed = await api("GET", "/api/approvals?decision=pending", { session: manager });
  assert.equal(listed.status, 200);
  assert.ok(Array.isArray(listed.json.approvals));
});

test("a user can set their own WhatsApp number via PATCH /api/auth/profile", async () => {
  const rep = repSession;
  const updated = await api("PATCH", "/api/auth/profile", { body: { phone: "+6281234567890" }, session: rep });
  assert.equal(updated.status, 200);
  assert.equal(updated.json.user.phone, "+6281234567890");

  const me = await api("GET", "/api/auth/me", { session: rep });
  assert.equal(me.json.user.phone, "+6281234567890");

  // clean up so it doesn't leak into other tests
  await api("PATCH", "/api/auth/profile", { body: { phone: "" }, session: rep });
});

test("an invalid WhatsApp number is rejected with 400", async () => {
  const rep = repSession;
  const updated = await api("PATCH", "/api/auth/profile", { body: { phone: "not-a-phone-number!!" }, session: rep });
  assert.equal(updated.status, 400);
});

test("submit/decide still succeed with notification env vars unset (GOOGLE_*/TWILIO not configured in this test run)", async () => {
  const rep = repSession;
  const manager = managerSession;
  const quote = await createDraft(rep, [cleanItem()]);
  const submitted = await api("POST", `/api/quotes/${quote.id}/submit`, { session: rep });
  assert.equal(submitted.status, 200);
  const decided = await api("POST", `/api/quotes/${quote.id}/decide`, {
    body: { decision: "approved", note: "" },
    session: manager,
  });
  assert.equal(decided.status, 200);
});

test("rep can delete their own never-submitted draft", async () => {
  const quote = await createDraft(repSession, [cleanItem()]);
  const deleted = await api("DELETE", `/api/quotes/${quote.id}`, { session: repSession });
  assert.equal(deleted.status, 200);
});

test("rep cannot delete an approved quote by reopening it to draft first (403)", async () => {
  const rep = repSession;
  const quote = await createDraft(rep, [cleanItem()], { targetMargin: 0.05, leaderMargin: 0.0 });
  await api("POST", `/api/quotes/${quote.id}/submit`, { session: rep });
  const decided = await api("POST", `/api/quotes/${quote.id}/decide`, {
    body: { decision: "approved", note: "ok" },
    session: managerSession,
  });
  assert.equal(decided.json.quote.status, "approved");
  const reopened = await api("POST", `/api/quotes/${quote.id}/reopen`, { session: rep });
  assert.equal(reopened.status, 200);
  assert.equal(reopened.json.quote.status, "draft");
  const deleted = await api("DELETE", `/api/quotes/${quote.id}`, { session: rep });
  assert.equal(deleted.status, 403);
});

// ---------------------------------------------------------------
// Run
// ---------------------------------------------------------------

async function main() {
  await setup();
  let passed = 0;
  const failures: { name: string; error: unknown }[] = [];
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`  ok  ${t.name}`);
      passed++;
    } catch (error) {
      console.log(`FAIL  ${t.name}`);
      failures.push({ name: t.name, error });
    }
  }
  await teardown();

  console.log(`\n${passed}/${tests.length} passed.`);
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
