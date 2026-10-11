import { afterAll, describe, expect, it } from "vitest";
import { createServer, type ServerResponse } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import express from "express";
import { Hono } from "hono";
import { D1DatabaseShim, AlwaysAllowRateLimit } from "../../scripts/d1-sqlite-shim";
import { DEFAULT_ASSUMPTIONS } from "../../shared/engine";
import type { User } from "../../shared/types";
import type { AuthedRequest } from "../auth";
import type { Bindings, Env } from "./env";
import { assistantRouter as workerRouter } from "./routes/assistant";

const context = {
  snapshot: { assumptions: DEFAULT_ASSUMPTIONS, items: [], regions: [], scenario: 0, meta: { date: "2026-10-10", validity: 30 } },
  sections: {},
};
const payloads = {
  ask: { context, messages: [{ role: "user", content: "hello" }] },
  document: { context, kind: "briefing" },
};
const user: User = { id: 1, email: "m@x", name: "M", role: "manager", active: 1, phone: "", created_at: "2026-10-10 00:00:00" };
const temp = mkdtempSync(path.join(tmpdir(), "silvy-quota-test-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));

async function fakeAgent(holdFirst: boolean, status = 200) {
  let calls = 0;
  let waiting: ServerResponse | undefined;
  let firstResolve!: () => void;
  const firstStarted = new Promise<void>((resolve) => { firstResolve = resolve; });
  const reply = (res: ServerResponse) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(status === 200 ? { answer: "ok", text: "ok", actions: [] } : { error: "response after generation failed" }));
  };
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      calls++;
      if (holdFirst && calls === 1) waiting = res;
      else reply(res);
      firstResolve();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing agent address");
  return {
    url: `http://127.0.0.1:${address.port}`, firstStarted, calls: () => calls,
    release: () => { if (waiting) { reply(waiting); waiting = undefined; } },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function driver(kind: "express" | "worker", url: string, monthly: number, daily: number) {
  const config = { SILVY_URL: url, SILVY_SHARED_SECRET: "s", SILVY_MONTHLY_LIMIT: String(monthly), SILVY_USER_DAILY_LIMIT: String(daily) };
  const countSql = "SELECT COUNT(*) AS n FROM audit_log WHERE entity='assistant' AND action IN ('ask','document')";
  if (kind === "worker") {
    const sqlite = new DatabaseSync(":memory:");
    const dir = path.resolve(import.meta.dirname, "../../migrations");
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(path.join(dir, file), "utf8"));
    sqlite.exec("INSERT INTO users(id,email,name,password_hash,role) VALUES(1,'m@x','M','x','manager')");
    const app = new Hono<Env>();
    app.use(async (c, next) => { c.set("user", user); await next(); });
    app.route("/api/assistant", workerRouter);
    const env = { DB: new D1DatabaseShim(sqlite), ASSISTANT_LIMITER: new AlwaysAllowRateLimit(), ...config } as unknown as Bindings;
    return {
      request: async (action: keyof typeof payloads, body: unknown = payloads[action]) => app.request(`/api/assistant/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, env),
      count: () => Number(sqlite.prepare(countSql).get()!.n),
      close: async () => sqlite.close(),
    };
  }
  process.env.DATABASE_PATH = path.join(temp, "db.sqlite");
  Object.assign(process.env, config);
  delete process.env.SILVY_IAM_AUTH;
  const { run, get } = await import("../db");
  run("INSERT OR IGNORE INTO users(id,email,name,password_hash,role) VALUES(1,'m@x','M','x','manager')");
  run("DELETE FROM audit_log WHERE entity='assistant'");
  const { assistantRouter } = await import("../routes/assistant");
  const app = express();
  app.use(express.json());
  app.use((req: AuthedRequest, _res, next) => { req.user = user; next(); });
  app.use("/api/assistant", assistantRouter);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing Express address");
  const root = `http://127.0.0.1:${address.port}`;
  return {
    request: (action: keyof typeof payloads, body: unknown = payloads[action]) => fetch(`${root}/api/assistant/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    count: () => get<{ n: number }>(countSql)!.n,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe.each(["express", "worker"] as const)("%s quota reservation", (kind) => {
  it.each([
    { cap: "monthly", monthly: 1, daily: 10 },
    { cap: "daily", monthly: 10, daily: 1 },
  ])("reserves the last $cap slot while generation is still running", async ({ monthly, daily }) => {
    const agent = await fakeAgent(true);
    const app = await driver(kind, agent.url, monthly, daily);
    let first: Promise<Response> | undefined;
    try {
      first = app.request("ask");
      await agent.firstStarted;
      const second = await app.request("document");
      await second.text();
      agent.release();
      const completed = await first;
      await completed.text();
      expect(completed.status).toBe(200);
      expect(second.status).toBe(429);
      expect(agent.calls()).toBe(1);
      expect(app.count()).toBe(1);
    } finally {
      agent.release();
      await first;
      await app.close();
      await agent.close();
    }
  });

  it("counts accepted generation even when its response fails", async () => {
    const agent = await fakeAgent(false, 502);
    const app = await driver(kind, agent.url, 1, 10);
    try {
      const first = await app.request("document");
      await first.text();
      const second = await app.request("ask");
      await second.text();
      expect(first.status).toBe(502);
      expect(second.status).toBe(429);
      expect(agent.calls()).toBe(1);
      expect(app.count()).toBe(1);
    } finally { await app.close(); await agent.close(); }
  });

  it("counts each successful request once, sharing the cap across asks and documents", async () => {
    const agent = await fakeAgent(false);
    const app = await driver(kind, agent.url, 2, 10);
    try {
      const statuses: number[] = [];
      for (const action of ["ask", "document", "ask"] as const) {
        const response = await app.request(action);
        statuses.push(response.status);
        await response.text();
      }
      expect(statuses).toEqual([200, 200, 429]);
      expect(agent.calls()).toBe(2);
      expect(app.count()).toBe(2);
    } finally { await app.close(); await agent.close(); }
  });

  it("does not consume a slot for an invalid request", async () => {
    const agent = await fakeAgent(false);
    const app = await driver(kind, agent.url, 1, 10);
    try {
      const invalid = await app.request("ask", {});
      await invalid.text();
      expect(invalid.status).toBe(400);
      expect(app.count()).toBe(0);
      const valid = await app.request("ask");
      await valid.text();
      expect(valid.status).toBe(200);
      expect(agent.calls()).toBe(1);
      expect(app.count()).toBe(1);
    } finally { await app.close(); await agent.close(); }
  });
});
