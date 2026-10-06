import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { D1DatabaseShim } from "../../../scripts/d1-sqlite-shim";
import { AccurateClient, signTimestamp } from "./client";
import { mapItem, mapStock } from "./mapping";
import { syncStep, type SyncConfig } from "./sync";
import { accurateRouter } from "../routes/accurate";
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

function fakeAccurate(opts: { items: Record<string, unknown>[]; stock: Record<number, Record<string, unknown>[]>; moveHost?: boolean }) {
  const log: string[] = [];
  let moved = false;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const page = <T,>(rows: T[], url: URL) => {
    const p = Number(url.searchParams.get("sp.page") ?? 1);
    const size = Number(url.searchParams.get("sp.pageSize") ?? 20);
    return json({ s: true, d: rows.slice((p - 1) * size, p * size), sp: { page: p, pageSize: size, pageCount: Math.max(1, Math.ceil(rows.length / size)), rowCount: rows.length } });
  };
  const impl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const h = new Headers(init?.headers);
    if (!h.get("authorization")?.startsWith("Bearer ") || !h.get("x-api-signature") || !h.get("x-api-timestamp")) {
      return json({ s: false, d: ["Unauthorized"] }, 401);
    }
    log.push(`${init?.method} ${url.host}${url.pathname}`);
    if (url.pathname === "/api/api-token.do") {
      return json({ s: true, d: { "data usaha": { host: "https://zeus.accurate.id", alias: "CV Test", id: 1 } } });
    }
    if (opts.moveHost && url.host === "zeus.accurate.id" && !moved) {
      moved = true;
      return new Response(null, { status: 308, headers: { location: `https://hera.accurate.id${url.pathname}${url.search}` } });
    }
    if (url.pathname.endsWith("/item/list.do")) return page(opts.items, url);
    if (url.pathname.endsWith("/warehouse/list.do")) return page([{ id: 1, name: "Gudang Utama" }, { id: 2, name: "Bogor" }], url);
    if (url.pathname.endsWith("/item/list-stock.do")) return page(opts.stock[Number(url.searchParams.get("warehouseId"))] ?? [], url);
    return json({ s: false, d: ["not found"] }, 404);
  };
  return { impl, log };
}

function freshDb() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = path.resolve(import.meta.dirname, "../../../migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(path.join(dir, f), "utf8"));
  return { sqlite, db: new D1DatabaseShim(sqlite) as unknown as D1Database };
}

const cfg: SyncConfig = { pageSize: 2, callsPerTick: 100, everyHours: 6 };
const creds = { token: "aat.test", signatureSecret: "secret" };

async function runToIdle(db: D1Database, f: typeof fetch, c = cfg) {
  const outcomes: string[] = [];
  for (let i = 0; i < 50; i++) {
    const r = await syncStep(db, "CV", creds, c, { deadline: Date.now() + 10_000, fetchImpl: f, gapMs: 0 });
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
  it("promotes one entity into the catalog without touching COGS, and flags cross-entity mismatches", async () => {
    const { sqlite, db } = freshDb();
    sqlite.exec(`INSERT INTO users(id, email, name, password_hash, role) VALUES (1, 'm@x', 'M', 'x', 'manager')`);
    sqlite.exec(`INSERT INTO catalog_items(code, name, uom, cogs, list_price, stock) VALUES ('A1', 'Kertas lama', 'Rim', 41000, 0, 0)`);
    await runToIdle(db, fakeAccurate({ items: ITEMS, stock: { 1: [{ no: "A1", quantity: 10 }], 2: [{ no: "A1", quantity: 5 }] } }).impl);
    // A PT row with the same code but a different price.
    sqlite.exec(`INSERT INTO accurate_items(entity, accurate_id, code, name, uom, unit_price, run_id) VALUES ('PT', 1, 'A1', 'Kertas A4', 'Rim', 52000, 'x')`);

    const app = new Hono<Env>();
    app.use(async (c, next) => {
      c.set("user", { id: 1, email: "m@x", name: "M", role: "manager" } as never);
      await next();
    });
    app.route("/api/accurate", accurateRouter);
    const env = { DB: db } as unknown as Env["Bindings"];

    const onlyExisting = await app.request("/api/accurate/apply", { method: "POST", body: JSON.stringify({ entity: "CV" }), headers: { "content-type": "application/json" } }, env);
    expect(onlyExisting.status).toBe(200);
    expect(sqlite.prepare("SELECT code, name, cogs, list_price, stock, source FROM catalog_items").all()).toEqual([
      { code: "A1", name: "Kertas A4", cogs: 41000, list_price: 50000, stock: 15, source: "accurate:CV" },
    ]);
    expect(sqlite.prepare("SELECT uom, factor FROM catalog_item_uoms WHERE code = 'A1'").all()).toEqual([{ uom: "Box", factor: 5 }]);

    await app.request("/api/accurate/apply", { method: "POST", body: JSON.stringify({ entity: "CV", insertNew: true }), headers: { "content-type": "application/json" } }, env);
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
