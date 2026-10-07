import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { D1DatabaseShim } from "../../scripts/d1-sqlite-shim";
import { DIGEST_CRON, MAX_RECIPIENTS, runFixDigest } from "./fixDigest";

function freshDb() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = path.resolve(import.meta.dirname, "../../migrations");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) sqlite.exec(readFileSync(path.join(dir, f), "utf8"));
  const user = sqlite.prepare("INSERT INTO users(email, name, password_hash, role, active) VALUES(?, ?, 'x', ?, ?)");
  user.run("m@test.local", "Manajer", "manager", 1);
  user.run("a@test.local", "Admin", "admin", 1);
  user.run("r@test.local", "Sales", "rep", 1);
  user.run("old@test.local", "Mantan", "manager", 0);
  return { sqlite, db: new D1DatabaseShim(sqlite) as unknown as D1Database };
}

const addTask = (sqlite: DatabaseSync, name: string, kind = "not_in_catalog") =>
  sqlite.prepare("INSERT INTO fix_tasks(kind, item_name, detail, dedupe, created_at) VALUES(?, ?, 'x', ?, '2026-10-06 01:00:00')").run(kind, name, `${kind}|${name}`);

/** Counts D1 round trips the way Cloudflare does (one per query). */
function counting(db: D1Database) {
  const c = { n: 0 };
  const wrap = (st: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(st, {
      get(t, k) {
        const f = (t as unknown as Record<string | symbol, unknown>)[k];
        if (k === "bind") return (...a: unknown[]) => wrap((f as (...x: unknown[]) => D1PreparedStatement).apply(t, a));
        if (k === "run" || k === "all" || k === "first") return (...a: unknown[]) => (c.n++, (f as (...x: unknown[]) => unknown).apply(t, a));
        return typeof f === "function" ? (f as (...x: unknown[]) => unknown).bind(t) : f;
      },
    });
  const proxied = new Proxy(db, {
    get(t, k) {
      if (k === "prepare") return (sql: string) => wrap(t.prepare(sql));
      const f = (t as unknown as Record<string | symbol, unknown>)[k];
      return typeof f === "function" ? (f as (...x: unknown[]) => unknown).bind(t) : f;
    },
  }) as D1Database;
  return { db: proxied, c };
}

describe("runFixDigest", () => {
  const morning = new Date("2026-10-07T01:00:00Z");

  it("emails active managers and admins once per Jakarta day, and again the next day", async () => {
    const { sqlite, db } = freshDb();
    addTask(sqlite, "Galon air");
    const sent: string[] = [];
    const send = async (to: string, subject: string) => void sent.push(`${to}|${subject}`);
    const first = await runFixDigest(db, { now: morning, link: "https://app/perbaikan", send });
    const retry = await runFixDigest(db, { now: new Date("2026-10-07T03:00:00Z"), link: "x", send });
    const tomorrow = await runFixDigest(db, { now: new Date("2026-10-08T01:00:00Z"), link: "x", send });
    expect(first).toEqual({ open: 1, sent: 2 });
    expect(retry.skipped).toBe("already-sent-today");
    expect(tomorrow.sent).toBe(2);
    expect(sent.slice(0, 2).sort()).toEqual([
      "a@test.local|Perlu diperbaiki: 1 item terbuka (tertua 1 hari)",
      "m@test.local|Perlu diperbaiki: 1 item terbuka (tertua 1 hari)",
    ]);
  });

  it("sends nothing when nothing is open, and ignores done tasks", async () => {
    const { sqlite, db } = freshDb();
    addTask(sqlite, "Sudah beres");
    sqlite.exec("UPDATE fix_tasks SET status = 'done'");
    const sent: string[] = [];
    expect(await runFixDigest(db, { now: morning, link: "x", send: async (to) => void sent.push(to) })).toEqual({ open: 0, sent: 0 });
    expect(sent).toEqual([]);
  });

  it("stays within the Free plan's 50 subrequests with the most recipients it will email", async () => {
    const { sqlite, db: raw } = freshDb();
    for (let i = 0; i < 30; i++) {
      sqlite.prepare("INSERT INTO users(email, name, password_hash, role, active) VALUES(?, 'M', 'x', 'manager', 1)").run(`m${i}@test.local`);
    }
    for (let i = 0; i < 300; i++) addTask(sqlite, `Item ${i}`, i % 2 ? "cogs_held" : "not_in_catalog");
    const { db, c } = counting(raw);
    let fetches = 0;
    // Gmail: one token request and one send per email.
    const r = await runFixDigest(db, { now: morning, link: "x", send: async () => void (fetches += 2) });
    expect(r.sent).toBe(MAX_RECIPIENTS);
    expect(c.n + fetches).toBeLessThanOrEqual(50);
  });

  it("is wired to a cron entry in wrangler.toml", () => {
    const toml = readFileSync(new URL("../../wrangler.toml", import.meta.url), "utf8");
    expect(toml).toContain(`"${DIGEST_CRON}"`);
  });
});
