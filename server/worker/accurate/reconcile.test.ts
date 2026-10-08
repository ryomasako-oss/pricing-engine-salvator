import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { D1DatabaseShim } from "../../../scripts/d1-sqlite-shim";
import { accurateRouter } from "../routes/accurate";
import { reconcileDue, reconcileExamples, runReconcile } from "./reconcile";
import { syncTick } from "./sync";
import { countTasksSql, listTasksSql, tasksForViewer } from "../../fixTasks";
import { countQueries, fakeAccurate } from "./testing";
import { CHECKS, CHECK_KEYS, desiredTasks, type ReconcileCounts } from "../../../shared/accurateReconcile";
import { digestEmail, type OpenTaskRow } from "../../../shared/fixTasks";
import type { Env } from "../env";

function freshDb() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = path.resolve(import.meta.dirname, "../../../migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(path.join(dir, f), "utf8"));
  return { sqlite, db: new D1DatabaseShim(sqlite) as unknown as D1Database };
}

/**
 * Catalog (cogs/list price per catalog unit) against Accurate PT staging.
 *   P1  Accurate sells below the catalog COGS (and differs from list price)
 *   P2  only the price differs
 *   U1  base unit differs: prices are per different units, so no price check
 *   S1  suspended in Accurate           M1  not in Accurate
 *   N1  Accurate has no selling price   OK1 identical (with negative stock in two warehouses)
 *   X1  only in Accurate: never counted
 */
function seed(sqlite: DatabaseSync, opts: { complete?: boolean } = {}) {
  sqlite.exec(`INSERT INTO catalog_items(code, name, uom, cogs, list_price) VALUES
    ('P1', 'Pulpen', 'Pcs', 9500, 12000), ('P2', 'Kertas', 'Rim', 0, 10000), ('U1', 'Spidol', 'Pcs', 100, 150),
    ('S1', 'Lem', 'Pcs', 0, 5000), ('M1', 'Jasa', 'Pcs', 0, 0), ('N1', 'Tinta', 'Pcs', 0, 0), ('OK1', 'Map', 'Pcs', 100, 200)`);
  const item = (id: number, code: string, uom: string, price: number, suspended = 0) =>
    `(${id}, '${code}', '${code}', '${uom}', ${price}, ${suspended})`;
  sqlite.exec(`INSERT INTO accurate_items(entity, accurate_id, code, name, uom, unit_price, suspended, run_id) SELECT 'PT', column1, column2, column3, column4, column5, column6, 'r1' FROM (VALUES
    ${[item(1, "P1", "Pcs", 8000), item(2, "P2", "Rim", 12500), item(3, "U1", "Box", 4800), item(4, "S1", "Pcs", 5000, 1),
      item(5, "N1", "Pcs", 0), item(6, "OK1", "Pcs", 200), item(7, "X1", "Pcs", 1)].join(",")})`);
  sqlite.exec(`INSERT INTO accurate_warehouses(entity, accurate_id, name, run_id) VALUES ('PT', 1, 'Utama', 'r1'), ('PT', 2, 'Cabang', 'r1')`);
  sqlite.exec(`INSERT INTO accurate_stock(entity, warehouse_id, item_code, quantity, run_id) VALUES
    ('PT', 1, 'OK1', -4, 'r1'), ('PT', 2, 'OK1', -1, 'r1'), ('PT', 1, 'P2', 6, 'r1')`);
  sqlite.exec(
    `INSERT OR REPLACE INTO accurate_sync_state(entity, phase, last_success_at) VALUES ('PT', 'idle', ${opts.complete === false ? "NULL" : "'2026-10-08T01:00:00.000Z'"})`,
  );
}

const openTasks = (sqlite: DatabaseSync) =>
  sqlite
    .prepare("SELECT code, qty, quote_id, detail, resolution FROM fix_tasks WHERE kind = 'accurate_check' AND status = 'open' ORDER BY code")
    .all() as { code: string; qty: number; quote_id: number | null; detail: string }[];

describe("cross-check of the catalog against Accurate", () => {
  it("counts each kind of mismatch, matching by code and comparing prices only within the same unit", async () => {
    const { sqlite, db } = freshDb();
    seed(sqlite);
    const { counts } = await runReconcile(db, "PT");
    expect(counts).toEqual({
      price_below_cogs: 1, // P1: 8.000 < COGS 9.500
      price_diff: 2, // P1 and P2; U1 is skipped (Pcs vs Box)
      uom_diff: 1, // U1
      suspended_in_accurate: 1, // S1
      negative_stock: 1, // OK1, in two warehouses, counted once
      missing_in_accurate: 1, // M1
      no_price_in_accurate: 1, // N1
    } satisfies ReconcileCounts);
  });

  it("opens one task per notifying kind (informational kinds stay in the report only), without a quote", async () => {
    const { sqlite, db } = freshDb();
    seed(sqlite);
    const r = await runReconcile(db, "PT");
    expect(r.open).toBe(5);
    const tasks = openTasks(sqlite);
    expect(tasks.map((t) => t.code)).toEqual(["negative_stock", "price_below_cogs", "price_diff", "suspended_in_accurate", "uom_diff"]);
    expect(tasks.every((t) => t.quote_id === null)).toBe(true);
    expect(tasks.find((t) => t.code === "price_diff")).toMatchObject({ qty: 2 });
    // The text names the item and both values, so a manager can judge without opening the report.
    expect(tasks.find((t) => t.code === "price_below_cogs")!.detail).toMatch(/P1 \(katalog Rp 9\.500, Accurate Rp 8\.000\)/);
    for (const k of CHECK_KEYS.filter((k) => !CHECKS[k].notify)) expect(tasks.some((t) => t.code === k)).toBe(false);
  });

  it("running again refreshes the same tasks instead of adding new ones, and closes a kind once it is clean", async () => {
    const { sqlite, db } = freshDb();
    seed(sqlite);
    await runReconcile(db, "PT");
    // The manager fixes P2's price in the catalog and Accurate's price for P1.
    sqlite.exec("UPDATE catalog_items SET list_price = 12500 WHERE code = 'P2'");
    sqlite.exec("UPDATE accurate_items SET unit_price = 15000 WHERE code = 'P1'");
    const again = await runReconcile(db, "PT");
    const open = openTasks(sqlite);
    // P1 (15.000) now differs from the list price 12.000 the other way round, so price_diff stays at 1; price_below_cogs is gone.
    expect(open.map((t) => [t.code, t.qty])).toEqual([["negative_stock", 1], ["price_diff", 1], ["suspended_in_accurate", 1], ["uom_diff", 1]]);
    expect(again.closed).toBe(1);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM fix_tasks WHERE code = 'price_diff'").get()).toEqual({ n: 1 });
    expect(sqlite.prepare("SELECT status, resolution FROM fix_tasks WHERE code = 'price_below_cogs'").get()).toEqual({
      status: "done",
      resolution: "Selisih sudah tidak ada (dicek otomatis).",
    });
  });

  it("a task a manager marked done comes back at the next check if the mismatch is still there", async () => {
    const { sqlite, db } = freshDb();
    seed(sqlite);
    await runReconcile(db, "PT");
    sqlite.exec("UPDATE fix_tasks SET status = 'done', resolved_at = datetime('now'), resolution = 'sudah dicek' WHERE code = 'uom_diff'");
    expect(openTasks(sqlite).some((t) => t.code === "uom_diff")).toBe(false);
    await runReconcile(db, "PT");
    expect(openTasks(sqlite).some((t) => t.code === "uom_diff")).toBe(true);
  });

  it("is due once per completed run, never during a run or before one", async () => {
    const { sqlite, db } = freshDb();
    seed(sqlite, { complete: false });
    expect(await reconcileDue(db, "PT")).toBe(false);
    sqlite.exec("UPDATE accurate_sync_state SET last_success_at = '2026-10-08T01:00:00.000Z'");
    expect(await reconcileDue(db, "PT")).toBe(true);
    sqlite.exec("UPDATE accurate_sync_state SET phase = 'items'");
    expect(await reconcileDue(db, "PT")).toBe(false);
    sqlite.exec("UPDATE accurate_sync_state SET phase = 'idle'");
    await runReconcile(db, "PT");
    expect(await reconcileDue(db, "PT")).toBe(false);
    sqlite.exec("UPDATE accurate_sync_state SET last_success_at = '2999-01-01T00:00:00.000Z'");
    expect(await reconcileDue(db, "PT")).toBe(true);
  });

  it("the cron tick checks a finished run once, in a tick without syncing, within the 50-query budget", async () => {
    const { sqlite, db } = freshDb();
    seed(sqlite);
    // Recent enough that the sync itself is not due again.
    sqlite.exec(`UPDATE accurate_sync_state SET last_success_at = '${new Date().toISOString()}'`);
    let queries = 0;
    const counting = new Proxy(db, {
      get(t, k) {
        const f = (t as unknown as Record<string | symbol, unknown>)[k];
        if (k === "prepare") return (sql: string) => (queries++, (f as (s: string) => unknown).call(t, sql));
        // Cloudflare counts each statement of a batch (D1 limits), and prepare() already counted them.
        return typeof f === "function" ? (f as (...x: unknown[]) => unknown).bind(t) : f;
      },
    }) as D1Database;
    const env = { DB: counting, ACCURATE_TOKEN_PT: "aat.t", ACCURATE_SIGNATURE_SECRET: "s" } as never;

    const first = await syncTick(env, { deadlineMs: 5_000 });
    expect(first.every((r) => r.outcome === "idle")).toBe(true);
    expect(openTasks(sqlite).length).toBe(5);
    expect(queries).toBeLessThanOrEqual(50);
    const spent = queries;

    queries = 0;
    await syncTick(env, { deadlineMs: 5_000 });
    expect(queries).toBeLessThan(spent); // nothing left to check: the tick is back to its cheap idle path
    expect(openTasks(sqlite).length).toBe(5);
  });

  it("staff never see these tasks or count them: they belong to no quote", async () => {
    const { sqlite, db } = freshDb();
    seed(sqlite);
    await runReconcile(db, "PT");
    const staff = listTasksSql("rep" as never, "open");
    const manager = listTasksSql("manager" as never, "open");
    expect(staff.scoped).toBe(true);
    expect(sqlite.prepare(staff.sql).all("open", 99, 99)).toEqual([]);
    expect(sqlite.prepare(manager.sql).all("open").length).toBe(5);
    const c = countTasksSql("rep" as never);
    expect(sqlite.prepare(c.sql).get(99, 99)).toEqual({ n: 0 });
    expect(sqlite.prepare(countTasksSql("manager" as never).sql).get()).toEqual({ n: 5 });
  });

  it("GET /reconcile reports the live counts and examples; POST refuses until a run has completed", async () => {
    const { sqlite, db } = freshDb();
    sqlite.exec(`INSERT INTO users(id, email, name, password_hash, role) VALUES (1, 'm@x', 'M', 'x', 'manager')`);
    const app = new Hono<Env>();
    app.use(async (c, next) => {
      c.set("user", { id: 1, email: "m@x", name: "M", role: "manager" } as never);
      await next();
    });
    app.route("/api/accurate", accurateRouter);
    const env = { DB: db } as unknown as Env["Bindings"];
    const call = async (method: string, url: string) => {
      const r = await app.request(url, { method }, env);
      return { status: r.status, json: (await r.json()) as Record<string, any> };
    };

    expect((await call("GET", "/api/accurate/reconcile")).json).toMatchObject({ ready: false, checks: [] });
    seed(sqlite, { complete: false });
    expect((await call("POST", "/api/accurate/reconcile")).status).toBe(409);

    sqlite.exec("UPDATE accurate_sync_state SET last_success_at = '2026-10-08T01:00:00.000Z'");
    const report = await call("GET", "/api/accurate/reconcile");
    expect(report.json.ready).toBe(true);
    expect(report.json.checks.map((c: { key: string; count: number }) => [c.key, c.count])).toEqual([
      ["price_below_cogs", 1], ["price_diff", 2], ["uom_diff", 1], ["suspended_in_accurate", 1],
      ["negative_stock", 1], ["missing_in_accurate", 1], ["no_price_in_accurate", 1],
    ]);
    // The list and the count come from one definition: they cannot disagree.
    const rows = await call("GET", "/api/accurate/reconcile/price_diff");
    expect(rows.json.rows.map((r: { code: string }) => r.code).sort()).toEqual(["P1", "P2"]);
    expect(rows.json.rows.find((r: { code: string }) => r.code === "P2")).toMatchObject({ catalog: "Rp 10.000", accurate: "Rp 12.500" });
    expect((await call("GET", "/api/accurate/reconcile/nonsense")).status).toBe(404);

    const run = await call("POST", "/api/accurate/reconcile");
    expect(run.status).toBe(200);
    expect(run.json.open).toBe(5);
    expect(openTasks(sqlite).length).toBe(5);
  });
});

describe("cross-check: review fixes (2026-10-08)", () => {
  afterEach(() => vi.unstubAllGlobals());

  const toml = readFileSync(new URL("../../../wrangler.toml", import.meta.url), "utf8");
  const v = (k: string) => toml.match(new RegExp(`^${k}\\s*=\\s*"([^"]*)"`, "m"))?.[1];
  /** Both Data Usaha configured, with the deployed tick size. */
  const bothEntities = (db: D1Database) =>
    ({
      DB: db,
      ACCURATE_TOKEN_CV: "aat.cv",
      ACCURATE_TOKEN_PT: "aat.pt",
      ACCURATE_SIGNATURE_SECRET: "s",
      ACCURATE_PAGE_SIZE: v("ACCURATE_PAGE_SIZE"),
      ACCURATE_CALLS_PER_TICK: v("ACCURATE_CALLS_PER_TICK"),
      ACCURATE_CATALOG_ENTITY: v("ACCURATE_CATALOG_ENTITY"),
    }) as never;
  const ptFinishedJustNow = (sqlite: DatabaseSync) =>
    sqlite.exec(`UPDATE accurate_sync_state SET last_success_at = '${new Date().toISOString()}' WHERE entity = 'PT'`);

  it("a CV token that keeps failing doesn't stop PT's finished run from being checked", async () => {
    // Before: the check waited for a tick where every entity was idle, so a
    // CV that errored on every tick meant PT was never checked.
    const { sqlite, db } = freshDb();
    seed(sqlite);
    ptFinishedJustNow(sqlite);
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ s: false, d: ["Invalid access token"] }), { status: 401 }));
    const r = await syncTick(bothEntities(db), { deadlineMs: 5_000 });
    expect(r.find((x) => x.entity === "CV")?.outcome).toBe("error");
    expect(openTasks(sqlite).length).toBe(5);
    expect(await reconcileDue(db, "PT")).toBe(false);
  });

  it("checking while CV syncs keeps every tick within 50 queries + Accurate calls", async () => {
    const { sqlite, db: raw } = freshDb();
    seed(sqlite);
    ptFinishedJustNow(sqlite);
    const { db, queries, reset } = countQueries(raw);
    const items = Array.from({ length: 450 }, (_, i) => ({ id: i + 1, no: `C${i}`, name: `Item ${i}`, unitPrice: 1000, unit1Name: "Pcs" }));
    const fake = fakeAccurate({ items, stock: { 1: items.map((i) => ({ no: i.no, quantity: 2 })), 2: items.slice(0, 150).map((i) => ({ no: i.no, quantity: 1 })) } });
    let calls = 0;
    vi.stubGlobal("fetch", ((u: RequestInfo | URL, i?: RequestInit) => (calls++, fake.impl(u, i))) as typeof fetch);
    let worst = 0;
    let cvDone = false;
    for (let tick = 0; tick < 60 && !cvDone; tick++) {
      calls = 0;
      reset();
      const r = await syncTick(bothEntities(db), { deadlineMs: 10_000 });
      worst = Math.max(worst, calls + queries());
      cvDone = r.find((x) => x.entity === "CV")?.outcome === "finished";
    }
    expect(cvDone).toBe(true);
    expect(openTasks(sqlite).length).toBe(5); // checked while CV was still syncing
    expect(worst).toBeLessThanOrEqual(50);
  }, 30_000);

  it("an item suspended in Accurate is only reported as suspended, not as a price to apply", async () => {
    const { sqlite, db } = freshDb();
    seed(sqlite);
    // "Terapkan" skips suspended items, so "Harga jual beda" (which says
    // Terapkan takes Accurate's price) must not list them.
    sqlite.exec("UPDATE accurate_items SET unit_price = 100 WHERE code = 'S1'");
    sqlite.exec("UPDATE catalog_items SET cogs = 4000 WHERE code = 'S1'");
    const { counts } = await runReconcile(db, "PT");
    expect(counts).toMatchObject({ suspended_in_accurate: 1, price_diff: 2, price_below_cogs: 1 });
    expect((await reconcileExamples(db, "PT", "price_diff", 10)).map((r) => r.code)).not.toContain("S1");
  });

  it("'below COGS' examples put the largest COGS gap first", async () => {
    const { sqlite, db } = freshDb();
    seed(sqlite);
    // B1 sells 90.000 under its COGS, but Accurate and the catalog agree on the
    // price, so ordering by the list-price gap put it after P1 (gap 1.500).
    sqlite.exec(`INSERT INTO catalog_items(code, name, uom, cogs, list_price) VALUES ('B1', 'Lemari', 'Pcs', 100000, 10000)`);
    sqlite.exec(`INSERT INTO accurate_items(entity, accurate_id, code, name, uom, unit_price, suspended, run_id) VALUES ('PT', 9, 'B1', 'B1', 'Pcs', 10000, 0, 'r1')`);
    expect((await reconcileExamples(db, "PT", "price_below_cogs", 1)).map((r) => r.code)).toEqual(["B1"]);
    expect((await reconcileExamples(db, "PT", "price_diff", 1)).map((r) => r.code)).toEqual(["P1"]);
  });

  it("a rep can't open the cross-check, and wouldn't see its figures in a task", async () => {
    const { sqlite, db } = freshDb();
    seed(sqlite);
    sqlite.exec(`INSERT INTO users(id, email, name, password_hash, role) VALUES (2, 'r@x', 'R', 'x', 'rep')`);
    const app = new Hono<Env>();
    app.use(async (c, next) => {
      c.set("user", { id: 2, email: "r@x", name: "R", role: "rep" } as never);
      await next();
    });
    app.route("/api/accurate", accurateRouter);
    const env = { DB: db } as unknown as Env["Bindings"];
    for (const [method, url] of [["GET", "/api/accurate/reconcile"], ["GET", "/api/accurate/reconcile/price_below_cogs"], ["POST", "/api/accurate/reconcile"]]) {
      expect((await app.request(url, { method }, env)).status).toBe(403);
    }
    // The task text names COGS ("katalog Rp 9.500"). Staff never list these
    // tasks (no quote), but if one ever reached them it must carry no figures.
    await runReconcile(db, "PT");
    const rows = sqlite.prepare("SELECT * FROM fix_tasks WHERE kind = 'accurate_check'").all() as never[];
    const seen = tasksForViewer("rep", rows) as unknown as { detail: string }[];
    expect(seen.some((t) => /Rp/.test(t.detail))).toBe(false);
    expect((tasksForViewer("manager", rows) as unknown as { detail: string }[]).some((t) => /Rp 9\.500/.test(t.detail))).toBe(true);
  });

  it("the daily email doesn't call a catalog check an item missing from a client offer", () => {
    const row = (over: Partial<OpenTaskRow>): OpenTaskRow => ({
      id: 1, kind: "accurate_check", item_name: "Harga jual beda", qty: 3, uom: "barang", detail: "3 barang.",
      created_at: "2026-10-08 01:00:00", quote_number: null, client_name: null, ...over,
    });
    const now = new Date("2026-10-08T02:00:00Z");
    expect(digestEmail([row({})], now, "https://x")!.html).not.toMatch(/ditawarkan susulan/);
    expect(digestEmail([row({}), row({ id: 2, kind: "cogs_held", quote_number: "Q-1" })], now, "https://x")!.html).toMatch(/ditawarkan susulan/);
  });
});

describe("desiredTasks", () => {
  it("only notifying kinds with a mismatch", () => {
    const zero = Object.fromEntries(CHECK_KEYS.map((k) => [k, 0])) as ReconcileCounts;
    expect(desiredTasks(zero, {})).toEqual([]);
    const t = desiredTasks({ ...zero, missing_in_accurate: 40, price_diff: 3 }, { price_diff: [{ code: "A", name: "", catalog: "Rp 1", accurate: "Rp 2" }] });
    expect(t.map((x) => x.key)).toEqual(["price_diff"]);
    expect(t[0].detail).toMatch(/^3 barang\./);
    expect(t[0].detail).toContain("A (katalog Rp 1, Accurate Rp 2)");
    expect(t[0].detail).toContain("dan lainnya");
    // A side with nothing to show is left out rather than printed as "-".
    const neg = desiredTasks({ ...zero, negative_stock: 1 }, { negative_stock: [{ code: "B", name: "", catalog: "", accurate: "stok -5" }] });
    expect(neg[0].detail).toContain("B (Accurate stok -5)");
    expect(neg[0].detail).not.toContain("dan lainnya");
  });
});
