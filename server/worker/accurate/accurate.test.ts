import { describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { D1DatabaseShim } from "../../../scripts/d1-sqlite-shim";
import { AccurateClient, signTimestamp } from "./client";
import { mapItem, mapStock } from "./mapping";
import { syncConfig, syncStep, type EntityKey, type SyncConfig } from "./sync";
import { accurateRouter } from "../routes/accurate";
import { countQueries, fakeAccurate } from "./testing";
import type { Env } from "../env";

describe("signTimestamp", () => {
  it("matches the worked example in Accurate's API Token guide", async () => {
    // Guide v1.0.3, "X-Api-Signature" section.
    expect(await signTimestamp("02/11/2023 09:01:01", "31d49b3dc632614495ff8071e5be44a1")).toBe(
      "8NxvylwwMcjGyzVXK0qbwNvFFuzHpwE9tECllVwLkbo=",
    );
  });
});

describe("mapItem", () => {
  it("reads flat and nested field shapes, and cleans units", () => {
    const flat = mapItem({
      id: 7, no: "ATK-001", name: "Pulpen Biru", unitPrice: 3500, unit1Name: "Pcs",
      unit2Name: "Box", ratio2: 12, unit3Name: "pcs", ratio3: 1, itemCategoryName: "ATK", suspended: false,
    });
    expect(flat).toMatchObject({
      accurateId: 7, code: "ATK-001", uom: "Pcs", unitPrice: 3500, category: "ATK",
      units: [{ uom: "Box", factor: 12 }],
    });
    const nested = mapItem({ id: 8, no: "ATK-002", name: "X", unit1: { name: "Rim" }, itemCategory: { name: "Kertas" } });
    expect(nested).toMatchObject({ uom: "Rim", category: "Kertas", unitPrice: 0 });
    expect(mapItem({ id: 9, name: "no code" })).toBeNull();
  });

  it("maps stock rows across known quantity field names", () => {
    expect(mapStock({ no: "A", quantity: -3 })).toEqual({ code: "A", quantity: -3 });
    expect(mapStock({ no: "B", availableToSell: "1,250" })).toEqual({ code: "B", quantity: 1250 });
    expect(mapStock({ name: "x" })).toBeNull();
  });
});

// ---- Fake Accurate server -------------------------------------------------

function freshDb() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = path.resolve(import.meta.dirname, "../../../migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(path.join(dir, f), "utf8"));
  return { sqlite, db: new D1DatabaseShim(sqlite) as unknown as D1Database };
}

const cfg: SyncConfig = { pageSize: 2, callsPerTick: 100, everyHours: 6 };
const creds = { token: "aat.test", signatureSecret: "secret" };

async function runToIdle(db: D1Database, f: typeof fetch, c = cfg, entity: EntityKey = "CV") {
  const outcomes: string[] = [];
  for (let i = 0; i < 50; i++) {
    const r = await syncStep(db, entity, creds, c, { deadline: Date.now() + 10_000, fetchImpl: f, gapMs: 0 });
    outcomes.push(r.outcome);
    if (r.outcome === "error") throw new Error(r.error);
    if (r.outcome === "finished" || r.outcome === "idle") break;
  }
  return outcomes;
}

const ITEMS = [
  { id: 1, no: "A1", name: "Kertas A4", unitPrice: 50000, unit1Name: "Rim", unit2Name: "Box", ratio2: 5 },
  { id: 2, no: "A2", name: "Pulpen", unitPrice: 3000, unit1Name: "Pcs" },
  { id: 3, no: "A3", name: "Stapler", unitPrice: 0, unit1Name: "Pcs" },
];

describe("syncStep", () => {
  it("pulls items, warehouses and stock in resumable ticks, then prunes deleted rows", async () => {
    const { sqlite, db } = freshDb();
    const fake = fakeAccurate({ items: ITEMS, stock: { 1: [{ no: "A1", quantity: 10 }, { no: "A2", quantity: -4 }], 2: [{ no: "A1", quantity: 5 }] } });

    // A tight budget forces several ticks; the cursor must carry across them.
    const outcomes = await runToIdle(db, fake.impl, { ...cfg, callsPerTick: 2 });
    expect(outcomes.at(-1)).toBe("finished");
    expect(outcomes.filter((o) => o === "progress").length).toBeGreaterThan(1);

    const items = sqlite.prepare("SELECT code, uom, unit_price, units FROM accurate_items ORDER BY code").all();
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({ code: "A1", uom: "Rim", unit_price: 50000, units: '[{"uom":"Box","factor":5}]' });
    const stock = sqlite.prepare("SELECT warehouse_id, item_code, quantity FROM accurate_stock ORDER BY warehouse_id, item_code").all();
    expect(stock).toEqual([
      { warehouse_id: 1, item_code: "A1", quantity: 10 },
      { warehouse_id: 1, item_code: "A2", quantity: -4 },
      { warehouse_id: 2, item_code: "A1", quantity: 5 },
    ]);

    // Not due again yet.
    expect(await runToIdle(db, fake.impl)).toEqual(["idle"]);

    // Item A3 deleted in Accurate → pruned on the next full run.
    sqlite.exec("UPDATE accurate_sync_state SET force_restart = 1");
    const fake2 = fakeAccurate({ items: ITEMS.slice(0, 2), stock: { 1: [{ no: "A1", quantity: 7 }] } });
    await runToIdle(db, fake2.impl);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM accurate_items").get()).toEqual({ n: 2 });
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM accurate_stock").get()).toEqual({ n: 1 });
  });

  it("follows a 308 host move, keeps the auth headers, and remembers the new host", async () => {
    const { sqlite, db } = freshDb();
    const fake = fakeAccurate({ items: ITEMS, stock: {}, moveHost: true });
    await runToIdle(db, fake.impl);
    expect(fake.log.some((l) => l.startsWith("GET hera.accurate.id/accurate/api/item/list.do"))).toBe(true);
    expect(sqlite.prepare("SELECT host FROM accurate_sync_state").get()).toEqual({ host: "https://hera.accurate.id" });
  });

  it("records an error without losing the cursor", async () => {
    const { sqlite, db } = freshDb();
    const broken: typeof fetch = async () => new Response(JSON.stringify({ s: false, d: ["Invalid or Revoked API Token"] }), { status: 401 });
    const r = await syncStep(db, "CV", creds, cfg, { deadline: Date.now() + 5000, fetchImpl: broken, gapMs: 0 });
    expect(r.outcome).toBe("error");
    expect(r.error).toContain("Invalid or Revoked API Token");
    const st = sqlite.prepare("SELECT phase, last_error, locked_until FROM accurate_sync_state").get() as Record<string, unknown>;
    expect(st.phase).toBe("items");
    expect(st.locked_until).toBeNull();
  });
});

describe("POST /api/accurate/apply", () => {
  it("promotes PT into the catalog without touching COGS, refuses CV, and flags cross-entity mismatches", async () => {
    const { sqlite, db } = freshDb();
    sqlite.exec(`INSERT INTO users(id, email, name, password_hash, role) VALUES (1, 'm@x', 'M', 'x', 'manager')`);
    sqlite.exec(`INSERT INTO catalog_items(code, name, uom, cogs, list_price, stock) VALUES ('A1', 'Kertas lama', 'Rim', 41000, 0, 0)`);
    await runToIdle(db, fakeAccurate({ items: ITEMS, stock: { 1: [{ no: "A1", quantity: 10 }], 2: [{ no: "A1", quantity: 5 }] } }).impl, cfg, "PT");
    // A CV row with the same code but a different price.
    sqlite.exec(`INSERT INTO accurate_items(entity, accurate_id, code, name, uom, unit_price, run_id) VALUES ('CV', 1, 'A1', 'Kertas A4', 'Rim', 52000, 'x')`);

    const app = new Hono<Env>();
    app.use(async (c, next) => {
      c.set("user", { id: 1, email: "m@x", name: "M", role: "manager" } as never);
      await next();
    });
    app.route("/api/accurate", accurateRouter);
    const env = { DB: db } as unknown as Env["Bindings"];
    const apply = (body: unknown) =>
      app.request("/api/accurate/apply", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }, env);

    // CV is synced for checking only; applying it would overwrite PT's prices and stock.
    const cv = await apply({ entity: "CV" });
    expect(cv.status).toBe(400);
    expect(((await cv.json()) as { error: string }).error).toMatch(/PT/);

    const onlyExisting = await apply({ entity: "PT" });
    expect(onlyExisting.status).toBe(200);
    expect(sqlite.prepare("SELECT code, name, cogs, list_price, stock, source FROM catalog_items").all()).toEqual([
      { code: "A1", name: "Kertas A4", cogs: 41000, list_price: 50000, stock: 15, source: "accurate:PT" },
    ]);
    expect(sqlite.prepare("SELECT uom, factor FROM catalog_item_uoms WHERE code = 'A1'").all()).toEqual([{ uom: "Box", factor: 5 }]);

    await apply({ entity: "PT", insertNew: true });
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM catalog_items").get()).toEqual({ n: 3 });

    const flags = (await (await app.request("/api/accurate/flags", {}, env)).json()) as {
      counts: Record<string, number>;
      negativeStock: unknown[];
      crossEntityMismatch: { code: string }[];
    };
    expect(flags.counts.overlapping_codes).toBe(1);
    expect(flags.crossEntityMismatch.map((r) => r.code)).toEqual(["A1"]);
    expect(flags.counts.no_selling_price).toBe(1);
  });
});

/** A Hono app with the Accurate routes as a manager, and a POST /apply helper. */
function applier(db: D1Database) {
  const app = new Hono<Env>();
  app.use(async (c, next) => {
    c.set("user", { id: 1, email: "m@x", name: "M", role: "manager" } as never);
    await next();
  });
  app.route("/api/accurate", accurateRouter);
  const env = { DB: db } as unknown as Env["Bindings"];
  return async (body: unknown) => {
    const r = await app.request("/api/accurate/apply", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }, env);
    return { status: r.status, json: (await r.json()) as Record<string, unknown> };
  };
}

describe("POST /api/accurate/apply keeps cost, unit and stock consistent (Codex review of develop 41764fe)", () => {
  it("doesn't switch the base unit of an item that has a COGS, and reports it; an item without COGS may switch", async () => {
    const { sqlite, db } = freshDb();
    sqlite.exec(`INSERT INTO users(id, email, name, password_hash, role) VALUES (1, 'm@x', 'M', 'x', 'manager')`);
    sqlite.exec(`INSERT INTO catalog_items(code, name, uom, cogs, list_price, stock) VALUES
      ('B1', 'Spidol', 'Pcs', 100, 150, 3), ('B2', 'Tinta', 'Pcs', 0, 0, 0)`);
    const items = [
      { id: 1, no: "B1", name: "Spidol", unitPrice: 4800, unit1Name: "Box", unit2Name: "Dus", ratio2: 10 },
      { id: 2, no: "B2", name: "Tinta", unitPrice: 9000, unit1Name: "Box" },
    ];
    await runToIdle(db, fakeAccurate({ items, stock: { 1: [{ no: "B1", quantity: 2 }, { no: "B2", quantity: 4 }] } }).impl, cfg, "PT");
    const r = await applier(db)({ entity: "PT" });
    expect(r.status).toBe(200);
    expect(sqlite.prepare("SELECT code, uom, cogs, list_price, stock FROM catalog_items ORDER BY code").all()).toEqual([
      { code: "B1", uom: "Pcs", cogs: 100, list_price: 150, stock: 3 },
      { code: "B2", uom: "Box", cogs: 0, list_price: 9000, stock: 4 },
    ]);
    expect(sqlite.prepare("SELECT code FROM catalog_item_uoms WHERE code = 'B1'").all()).toEqual([]);
    expect(r.json.unitMismatch).toEqual(["B1"]);
  });

  it("doesn't apply stock while a sync run is still in progress", async () => {
    const { sqlite, db } = freshDb();
    sqlite.exec(`INSERT INTO users(id, email, name, password_hash, role) VALUES (1, 'm@x', 'M', 'x', 'manager')`);
    sqlite.exec(`INSERT INTO catalog_items(code, name, uom, cogs, list_price, stock) VALUES ('C1', 'Kertas', 'Pcs', 1000, 1500, 0)`);
    const items = [{ id: 1, no: "C1", name: "Kertas", unitPrice: 1500, unit1Name: "Pcs" }];
    await runToIdle(db, fakeAccurate({ items, stock: { 1: [{ no: "C1", quantity: 5 }] } }).impl, cfg, "PT");
    const apply = applier(db);
    const first = await apply({ entity: "PT" });
    // The next run has started and so far re-read only warehouse 2: staging now
    // mixes this run's row with the last run's warehouse-1 row.
    sqlite.exec(`UPDATE accurate_sync_state SET phase = 'stock', run_id = 'run-2' WHERE entity = 'PT'`);
    sqlite.exec(`INSERT INTO accurate_stock(entity, warehouse_id, item_code, quantity, run_id) VALUES ('PT', 2, 'C1', 2, 'run-2')`);
    const during = await apply({ entity: "PT" });
    expect(first.json.stockApplied).toBe(true);
    expect(during.json.stockApplied).toBe(false);
    expect(sqlite.prepare("SELECT stock FROM catalog_items WHERE code = 'C1'").get()).toEqual({ stock: 5 });
  });

  // Codex re-review: the check ran before the write, so a run starting in
  // between still had its half-read stock (2 + 5 = 7) applied.
  it("doesn't apply stock when a sync run starts between apply's checks and its write", async () => {
    const { sqlite, db } = freshDb();
    sqlite.exec(`INSERT INTO users(id, email, name, password_hash, role) VALUES (1, 'm@x', 'M', 'x', 'manager')`);
    sqlite.exec(`INSERT INTO catalog_items(code, name, uom, cogs, list_price, stock) VALUES ('C1', 'Kertas', 'Pcs', 1000, 1500, 0)`);
    const items = [{ id: 1, no: "C1", name: "Kertas", unitPrice: 1500, unit1Name: "Pcs" }];
    await runToIdle(db, fakeAccurate({ items, stock: { 1: [{ no: "C1", quantity: 5 }] } }).impl, cfg, "PT");
    // The run starts right before apply's write reaches the database.
    const racing = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== "batch") return Reflect.get(target, prop, receiver);
        return (statements: D1PreparedStatement[]) => {
          sqlite.exec(`UPDATE accurate_sync_state SET phase = 'stock', run_id = 'run-2' WHERE entity = 'PT'`);
          sqlite.exec(`INSERT INTO accurate_stock(entity, warehouse_id, item_code, quantity, run_id) VALUES ('PT', 2, 'C1', 2, 'run-2')`);
          return target.batch(statements);
        };
      },
    });
    const r = await applier(racing)({ entity: "PT" });
    expect(r.json.stockApplied).toBe(false);
    expect(sqlite.prepare("SELECT stock FROM catalog_items WHERE code = 'C1'").get()).toEqual({ stock: 0 });
  });

  // Codex re-review: the guard covered updates only; a new item inserted
  // during a run still took the mixed stock (2 + 5 = 7).
  it("doesn't give a newly inserted item stock while a sync run is in progress", async () => {
    const { sqlite, db } = freshDb();
    sqlite.exec(`INSERT INTO users(id, email, name, password_hash, role) VALUES (1, 'm@x', 'M', 'x', 'manager')`);
    const items = [{ id: 1, no: "N1", name: "Baru", unitPrice: 1500, unit1Name: "Pcs" }];
    await runToIdle(db, fakeAccurate({ items, stock: { 1: [{ no: "N1", quantity: 5 }] } }).impl, cfg, "PT");
    sqlite.exec(`UPDATE accurate_sync_state SET phase = 'stock', run_id = 'run-2' WHERE entity = 'PT'`);
    sqlite.exec(`INSERT INTO accurate_stock(entity, warehouse_id, item_code, quantity, run_id) VALUES ('PT', 2, 'N1', 2, 'run-2')`);
    const r = await applier(db)({ entity: "PT", insertNew: true });
    expect(r.json.stockApplied).toBe(false);
    expect(sqlite.prepare("SELECT stock FROM catalog_items WHERE code = 'N1'").get()).toEqual({ stock: 0 });
  });
});

describe("AccurateClient", () => {
  it("never sends credentials to a host other than the account server before resolving", async () => {
    const seen: string[] = [];
    const client = new AccurateClient(creds, null, (async (u: string) => {
      seen.push(new URL(u).host);
      return new Response(JSON.stringify({ s: true, d: { "data usaha": { host: "https://zeus.accurate.id/" } } }));
    }) as typeof fetch, 0);
    expect((await client.tokenInfo()).host).toBe("https://zeus.accurate.id");
    expect(seen).toEqual(["account.accurate.id"]);
  });
});

// Found by running the real Worker locally: the client kept the global fetch in
// a field and called it as this.fetchImpl(...), so fetch ran with the client as
// its receiver. Node allows that; Cloudflare Workers throws "Illegal invocation:
// function called with incorrect `this` reference", which would have failed the
// first real sync. No test saw it because they all inject a fake fetch.
describe("AccurateClient under Workers' rules for fetch", () => {
  it("uses the default global fetch without a receiver (Workers refuses fetch called as a method)", async () => {
    const strictFetch = function (this: unknown, input: RequestInfo | URL) {
      if (this !== undefined && this !== globalThis) {
        throw new TypeError("Illegal invocation: function called with incorrect `this` reference.");
      }
      expect(new URL(String(input)).host).toBe("account.accurate.id");
      return Promise.resolve(new Response(JSON.stringify({ s: true, d: { "data usaha": { host: "https://zeus.accurate.id/" } } })));
    };
    vi.stubGlobal("fetch", strictFetch);
    try {
      const client = new AccurateClient(creds, null, undefined, 0);
      expect((await client.tokenInfo()).host).toBe("https://zeus.accurate.id");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("AccurateClient only sends credentials to Accurate", () => {
  // Every request carries the Bearer token and a signature, so a redirect or a
  // host from api-token.do that points outside accurate.id must stop the call
  // before anything is sent there.
  const respond = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), init);

  it("refuses a 308 to a host outside accurate.id, without contacting it", async () => {
    const seen: string[] = [];
    const client = new AccurateClient(creds, "https://zeus.accurate.id", (async (u: string) => {
      seen.push(new URL(u).host);
      return new Response(null, { status: 308, headers: { location: "https://evil.example.com/accurate/api/item/list.do" } });
    }) as typeof fetch, 0);
    await expect(client.list("item/list.do", {})).rejects.toThrow(/di luar accurate\.id/);
    expect(seen).toEqual(["zeus.accurate.id"]);
  });

  it("refuses a database host from api-token.do outside accurate.id, or over http", async () => {
    for (const host of ["https://accurate.id.evil.com", "http://zeus.accurate.id"]) {
      const seen: string[] = [];
      const client = new AccurateClient(creds, null, (async (u: string) => {
        seen.push(new URL(u).host);
        return respond({ s: true, d: { "data usaha": { host } } });
      }) as typeof fetch, 0);
      await expect(client.list("item/list.do", {})).rejects.toThrow(/di luar accurate\.id/);
      expect(seen).toEqual(["account.accurate.id"]);
    }
  });

  it("still follows a 308 between Accurate hosts", async () => {
    const client = new AccurateClient(creds, "https://zeus.accurate.id", (async (u: string) =>
      new URL(u).host === "zeus.accurate.id"
        ? new Response(null, { status: 308, headers: { location: "https://hera.accurate.id/accurate/api/item/list.do" } })
        : respond({ s: true, d: [], sp: { page: 1, pageCount: 1, rowCount: 0 } })) as typeof fetch, 0);
    await client.list("item/list.do", {});
    expect(client.movedTo).toBe("https://hera.accurate.id");
  });
});

describe("Workers Free plan budget (Ryoma, 2026-10-06)", () => {
  // Free plan: 50 subrequests per invocation, and D1 queries count as
  // subrequests (developers.cloudflare.com/workers/platform/limits). The
  // deployed tick size in wrangler.toml must keep every tick under that.
  const toml = readFileSync(new URL("../../../wrangler.toml", import.meta.url), "utf8");
  const v = (k: string) => toml.match(new RegExp(`^${k}\\s*=\\s*"([^"]*)"`, "m"))?.[1];

  it("every sync tick with the deployed settings stays within 50 subrequests (Accurate + D1)", async () => {
    const { db: raw } = freshDb();
    const { db, queries, reset } = countQueries(raw);
    const items = Array.from({ length: 1234 }, (_, i) => ({ id: i + 1, no: `C${i}`, name: `Item ${i}`, unitPrice: 1000, unit1Name: "Pcs" }));
    const stock = { 1: items.slice(0, 700).map((i) => ({ no: i.no, quantity: 3 })), 2: items.slice(0, 300).map((i) => ({ no: i.no, quantity: 1 })) };
    const fake = fakeAccurate({ items, stock });
    let calls = 0;
    const counted: typeof fetch = (u, i) => (calls++, fake.impl(u, i));
    const deployed = syncConfig({ ACCURATE_PAGE_SIZE: v("ACCURATE_PAGE_SIZE"), ACCURATE_CALLS_PER_TICK: v("ACCURATE_CALLS_PER_TICK") } as never);

    let finished = false;
    let ticks = 0;
    let worst = 0;
    for (; ticks < 200 && !finished; ticks++) {
      calls = 0;
      reset();
      const r = await syncStep(db, "PT", creds, deployed, { deadline: Date.now() + 10_000, fetchImpl: counted, gapMs: 0 });
      if (r.outcome === "error") throw new Error(r.error);
      worst = Math.max(worst, calls + queries());
      finished = r.outcome === "finished";
    }
    expect(finished).toBe(true);
    expect(worst).toBeLessThanOrEqual(50);
  });

  it("the catalog takes Accurate data from PT", () => {
    expect(v("ACCURATE_CATALOG_ENTITY")).toBe("PT");
  });
});
