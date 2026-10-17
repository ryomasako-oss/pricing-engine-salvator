import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { D1DatabaseShim } from "../../scripts/d1-sqlite-shim";
import { catalogRouter } from "./routes/catalog";
import { normalizeText } from "../../shared/match";
import type { Env } from "./env";

function freshDb() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = path.resolve(import.meta.dirname, "../../migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(path.join(dir, f), "utf8"));
  sqlite.exec(`INSERT INTO users(id, email, name, password_hash, role) VALUES (1, 'm@x', 'M', 'x', 'manager'), (2, 'r@x', 'R', 'x', 'rep')`);
  sqlite.exec(`INSERT INTO clients(id, name, code) VALUES (1, 'PT Uji', 'UJI')`);
  sqlite.exec(`INSERT INTO catalog_items(code, name, uom, cogs, list_price) VALUES
    ('A1', 'KERTAS HVS A4 70GR SINAR DUNIA', 'Rim', 40000, 55000),
    ('A2', 'KERTAS HVS A4 70GR BOLA DUNIA', 'Rim', 41000, 56000),
    ('B1', 'SPIDOL WHITEBOARD SNOWMAN HITAM', 'Pcs', 5000, 8000)`);
  return { sqlite, db: new D1DatabaseShim(sqlite) as unknown as D1Database };
}

function app(db: D1Database, role = "manager") {
  const a = new Hono<Env>();
  a.use(async (c, next) => {
    c.set("user", { id: role === "rep" ? 2 : 1, email: "m@x", name: "M", role } as never);
    await next();
  });
  a.route("/api/catalog", catalogRouter);
  const env = { DB: db } as unknown as Env["Bindings"];
  const post = (p: string, body: unknown) =>
    a.request(p, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }, env);
  return { post, get: (p: string) => a.request(p, {}, env) };
}

const NAME = "kertas fotocopy a4";
const line = { name: NAME, qty: 10 };

describe("pembelajaran pencocokan: dari koreksi sampai pencocokan berikutnya", () => {
  it("records every reviewed row, right or wrong, and with no client chosen", async () => {
    const { sqlite, db } = freshDb();
    const { post } = app(db, "rep");
    const res = await post("/api/catalog/aliases", {
      client_id: null,
      pairs: [], // no client: nothing becomes a rule
      feedback: [
        { text: "KERTAS HVS A4 70GR SINAR DUNIA", status: "match", via: "name", suggested: "A1", score: 0.95, chosen: "A1" },
        { text: "kertas fotocopy", status: "review", via: "name", suggested: "A1", score: 0.6, chosen: "A2" },
        { text: "barang aneh", status: "none", via: "", suggested: null, score: 0, chosen: null },
        { text: "teh kotak", status: "none", via: "", suggested: null, score: 0, chosen: "BARU-0001", isNew: true },
      ],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ saved: 0, recorded: 4 });
    expect(sqlite.prepare("SELECT outcome, COUNT(*) AS n FROM match_feedback GROUP BY outcome ORDER BY outcome").all()).toEqual([
      { outcome: "accepted", n: 1 },
      { outcome: "corrected", n: 1 },
      { outcome: "dropped", n: 1 },
      { outcome: "new_item", n: 1 },
    ]);
    // Stored normalised, so the penalty and the matcher agree on the key.
    expect(sqlite.prepare("SELECT text FROM match_feedback WHERE outcome = 'accepted'").get()).toEqual({
      text: normalizeText("KERTAS HVS A4 70GR SINAR DUNIA"),
    });
  });

  it("a rep still may not write a company-wide rule", async () => {
    const { db } = freshDb();
    const r = await app(db, "rep").post("/api/catalog/aliases", { client_id: null, pairs: [{ text: "x", code: "A1" }] });
    expect(r.status).toBe(403);
  });

  it("a corrected pairing stops being auto-accepted next time, but stays on the list", async () => {
    const { db } = freshDb();
    const { post } = app(db);
    const matchOnce = async () => {
      const r = await post("/api/catalog/match", { client_id: 1, lines: [line] });
      return (await r.json()) as { results: { status: string; candidates: { id: number }[] }[]; items: { id: number; code: string }[] };
    };

    const before = await matchOnce();
    const topBefore = before.items.find((i) => i.id === before.results[0].candidates[0].id)!.code;
    expect(before.results[0].status).toBe("review");

    // Two reps correct that guess away; one keeps it.
    const say = (chosen: string) => ({ text: NAME, status: "review", via: "name", suggested: topBefore, score: 0.6, chosen });
    const other = topBefore === "A1" ? "A2" : "A1";
    await post("/api/catalog/aliases", { client_id: null, pairs: [], feedback: [say(other), say(other), say(topBefore)] });

    const after = await matchOnce();
    const codes = after.results[0].candidates.map((c) => after.items.find((i) => i.id === c.id)!.code);
    // Still offered — one correction can itself be the mistake — but no longer first.
    expect(codes).toContain(topBefore);
    expect(codes[0]).not.toBe(topBefore);
  });

  it("the report counts what happened and names the wording that keeps missing", async () => {
    const { db } = freshDb();
    const { post, get } = app(db);
    await post("/api/catalog/aliases", {
      client_id: 1,
      pairs: [],
      feedback: [
        { text: "kertas fotocopy", status: "review", via: "name", suggested: "A1", score: 0.6, chosen: "A2" },
        { text: "kertas fotocopy", status: "review", via: "name", suggested: "A1", score: 0.6, chosen: "A2" },
        { text: "spidol", status: "match", via: "name", suggested: "B1", score: 0.9, chosen: "B1" },
      ],
    });
    const r = (await (await get("/api/catalog/match-learning")).json()) as any;
    expect(r).toMatchObject({ rows: 3, accepted: 1, corrected: 2, dropped: 0, newItem: 0, rejectedPairs: 1 });
    expect(r.accuracy).toBeCloseTo(1 / 3, 3);
    expect(r.topMissed[0]).toMatchObject({ rawText: "kertas fotocopy", corrected: 2, suggested: "A1", chosen: "A2" });
    expect(r.weeks).toHaveLength(1);
  });

  it("is closed to sales reps (it shows which catalog codes a guess lost to)", async () => {
    const { db } = freshDb();
    expect((await app(db, "rep").get("/api/catalog/match-learning")).status).toBe(403);
  });
});
