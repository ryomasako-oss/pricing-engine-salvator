import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { D1DatabaseShim } from "../../scripts/d1-sqlite-shim";
import { quotesRouter } from "./routes/quotes";
import { salesOrdersRouter } from "./routes/salesOrders";
import { clientsRouter } from "./routes/clients";
import { fmsIntegrationRouter } from "./routes/fmsIntegration";
import { backoffSeconds, dispatchSoOutbox } from "./fms/dispatch";
import { signHex, verifySignature } from "./fms/signing";
import { computeEngine, DEFAULT_ASSUMPTIONS, DEFAULT_REGIONS } from "../../shared/engine";
import { catalogPageSchema, clientsPageSchema, peEventSchema } from "../../shared/fmsContract";
import type { Bindings, Env } from "./env";
import type { QuoteItem, Role } from "../../shared/types";

/* Sales Order (docs/integrasi-pe-fms.md, RENCANA F3.7 + F4b) through the real
   routes on an in-memory D1 built from every migration. */

const REP = 1, MANAGER = 2, OTHER_REP = 3, ADMIN = 4;
const ROLES: Record<number, Role> = { [REP]: "rep", [MANAGER]: "manager", [OTHER_REP]: "rep", [ADMIN]: "admin" };
const PE_SECRET = "p".repeat(40);
const FMS_SECRET = "f".repeat(40);

const item = (over: Partial<QuoteItem> & Pick<QuoteItem, "lineNo" | "code">): QuoteItem => ({
  id: `l${over.lineNo}`,
  name: `Barang ${over.code}`,
  uom: "Pcs",
  qty: 10,
  cogs: 10_000,
  rrp: 20_000,
  role: "CORE",
  ...over,
});

const LINES: QuoteItem[] = [
  item({ lineNo: 1, code: "ATK-001", uom: "Box", qty: 2 }),
  item({ lineNo: 2, code: "ATK-002", qty: 5, manualPrice: [null, 17_500, null] }),
  item({ lineNo: 3, code: "ATK-003", held: true, holdReason: "sales" }),
  item({ lineNo: 4, code: "", name: "Kursi lipat merah", unmatched: true, held: true, holdReason: "unmatched" }),
];

function setup(opts: { flag?: "0" | "1" | null; env?: Partial<Bindings> } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  const dir = path.resolve(import.meta.dirname, "../../migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(path.join(dir, f), "utf8"));
  sqlite.exec(`INSERT INTO users(id, email, name, password_hash, role) VALUES
    (1, 'rep@x', 'Rina Sales', 'x', 'rep'), (2, 'mgr@x', 'Budi Manajer', 'x', 'manager'),
    (3, 'rep2@x', 'Sales Lain', 'x', 'rep'), (4, 'adm@x', 'Admin', 'x', 'admin')`);
  sqlite.exec(`INSERT INTO clients(id, name, code, address, contact_name, contact_phone)
    VALUES (10, 'PT Contoh', 'C001', 'Jl. Melati No. 5, Bandung', 'Bu Rina', '08123456789'),
           (11, 'PT Tanpa Kode', '', 'Jl. Mawar', 'Pak Adi', '')`);
  sqlite.exec(`INSERT INTO catalog_items(code, name, uom, cogs, list_price, stock, category) VALUES
    ('ATK-001', 'Pulpen Hitam', 'Pcs', 10000, 20000, 50, 'ATK'),
    ('ATK-002', 'Kertas A4', 'Pcs', 10000, 20000, 5, 'Kertas'),
    ('ATK-003', 'Map Plastik', 'Pcs', 10000, 20000, 0, 'ATK')`);
  sqlite.exec(`INSERT INTO catalog_item_uoms(code, uom, factor) VALUES ('ATK-001', 'Box', 24)`);
  if (opts.flag === null) sqlite.exec("DELETE FROM settings WHERE key = 'sales_order_enabled'");
  else sqlite.exec(`UPDATE settings SET value = '${opts.flag ?? "1"}' WHERE key = 'sales_order_enabled'`);

  const shim = new D1DatabaseShim(sqlite);
  // Runs once, just before the first statement starting with `prefix`.
  let race: { prefix: string; fn: () => void } | undefined;
  const db = new Proxy(shim, {
    get(target, prop) {
      if (prop !== "prepare") return Reflect.get(target, prop);
      return (sql: string) => {
        if (race && sql.trimStart().startsWith(race.prefix)) {
          const fn = race.fn;
          race = undefined;
          fn();
        }
        return target.prepare(sql);
      };
    },
  }) as unknown as D1Database;
  const env = { DB: db, ...opts.env } as unknown as Bindings;
  const waits: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => waits.push(p), passThroughOnException: () => undefined, props: {} } as unknown as ExecutionContext;

  const app = (userId?: number) => {
    const a = new Hono<Env>();
    a.use(async (c, next) => {
      if (userId) c.set("user", { id: userId, email: "x@x", name: `U${userId}`, role: ROLES[userId] } as never);
      await next();
    });
    a.route("/api/quotes", quotesRouter);
    a.route("/api/sales-orders", salesOrdersRouter);
    a.route("/api/clients", clientsRouter);
    a.route("/api/integrations/fms", fmsIntegrationRouter);
    return a;
  };
  const as = (userId: number) => async (method: string, p: string, body?: unknown) => {
    const r = await app(userId).request(p, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json" } }, env, ctx);
    return { status: r.status, json: (await r.json()) as Record<string, any> };
  };
  /** A raw request with no login, as FMS sends it. */
  const raw = (p: string, init: RequestInit) => app().request(p, init, env, ctx);

  let quoteSeq = 0;
  const quote = (status: string, o: { items?: QuoteItem[]; scenario?: number; client?: number | null; owner?: number } = {}) => {
    quoteSeq++;
    const r = sqlite
      .prepare(
        `INSERT INTO quotes(number, title, client_id, status, scenario, items, regions, assumptions, meta, created_by)
         VALUES (?, 'Uji', ?, ?, ?, ?, ?, ?, '{}', ?)`,
      )
      .run(
        `HK/SIP/Q/2611/${String(quoteSeq).padStart(3, "0")}`,
        o.client === undefined ? 10 : o.client,
        status,
        o.scenario ?? 1,
        JSON.stringify(o.items ?? LINES),
        JSON.stringify(DEFAULT_REGIONS),
        JSON.stringify(DEFAULT_ASSUMPTIONS),
        o.owner ?? REP,
      );
    return Number(r.lastInsertRowid);
  };
  const one = <T = Record<string, any>>(sql: string, ...params: (string | number)[]) => sqlite.prepare(sql).get(...params) as T;
  const many = <T = Record<string, any>>(sql: string, ...params: (string | number)[]) => sqlite.prepare(sql).all(...params) as T[];
  return { sqlite, env, as, raw, quote, one, many, waits, race: (prefix: string, fn: () => void) => { race = { prefix, fn }; } };
}

type T = ReturnType<typeof setup>;

async function makeSo(t: T, quoteId: number, body: Record<string, unknown> = {}) {
  const r = await t.as(REP)("POST", `/api/quotes/${quoteId}/sales-order`, body);
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return r.json.salesOrder as { id: number; number: string };
}

/** A fake FMS: checks PE's signature like the real receiver, then answers with `reply`. */
function fakeFms(reply: (body: any) => Response | Promise<Response>) {
  const calls: { body: any; init: RequestInit }[] = [];
  const fetcher = (async (_url: string, init: RequestInit) => {
    const h = init.headers as Record<string, string>;
    const ok = await verifySignature(PE_SECRET, h["x-pe-timestamp"], h["x-pe-signature"], (ts) => `${ts}.${init.body}`);
    if (!ok) return new Response('{"error":"bad sig"}', { status: 401 });
    const body = JSON.parse(String(init.body));
    calls.push({ body, init });
    return reply(body);
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}
const ack = (o: Record<string, unknown> = {}) => Response.json({ received: true, duplicate: false, applied: true, ...o });
const dispatchEnv = (t: T, over: Partial<Bindings> = {}) =>
  ({ ...t.env, PE_FMS_SECRET: PE_SECRET, FMS_SO_URL: "https://fms.example/api/webhooks/pricing-engine", ...over }) as Bindings;

afterEach(() => vi.restoreAllMocks());

/* ---------------- membuat SO ---------------- */

describe("POST /api/quotes/:id/sales-order", () => {
  it("from an approved quote: SO, outbox, timeline and audit in one go, quote becomes won", async () => {
    const t = setup();
    const q = t.quote("approved");
    const before = t.one<{ version: number }>("SELECT version FROM quotes WHERE id = ?", q);
    const r = await t.as(REP)("POST", `/api/quotes/${q}/sales-order`, { customerPoNumber: "PO-123/XI/2026", requestedDate: "2999-01-02", note: "Kirim pagi" });
    expect(r.status).toBe(201);
    expect(r.json.salesOrder.number).toMatch(/^HK\/SIP\/SO\/\d{4}\/001$/);

    const quoteNow = t.one("SELECT status, version FROM quotes WHERE id = ?", q);
    expect(quoteNow).toEqual({ status: "won", version: before.version + 1 });
    const so = t.one("SELECT * FROM sales_orders WHERE quote_id = ?", q);
    expect(so).toMatchObject({ status: "open", sync_state: "pending", client_id: 10, ship_to_name: "Bu Rina", ship_to_phone: "08123456789", ship_to_address: "Jl. Melati No. 5, Bandung", customer_po_number: "PO-123/XI/2026", requested_date: "2999-01-02", note: "Kirim pagi", quote_rev_no: 1, created_by: REP });
    expect(t.many("SELECT kind FROM sales_order_events WHERE sales_order_id = ?", so.id)).toEqual([{ kind: "created" }]);
    expect(t.one("SELECT COUNT(*) AS n FROM audit_log WHERE entity = 'sales_order' AND entity_id = ? AND action = 'created'", so.id)).toEqual({ n: 1 });
    expect(t.one("SELECT COUNT(*) AS n FROM audit_log WHERE entity = 'quote' AND entity_id = ? AND action = 'status_won'", q)).toEqual({ n: 1 });

    const out = t.one<{ id: number; type: string; body: string }>("SELECT id, type, body FROM so_outbox WHERE sales_order_id = ?", so.id);
    expect(out.type).toBe("sales_order.created");
    const event = JSON.parse(out.body);
    expect(peEventSchema.safeParse(event).success).toBe(true);
    expect(event.sequence).toBe(out.id);
    expect(event.payload).toMatchObject({
      soNumber: so.number, quoteNumber: "HK/SIP/Q/2611/001", quoteRevNo: 1, entity: "PT", customerPoNumber: "PO-123/XI/2026",
      client: { code: "C001", name: "PT Contoh" }, shipTo: { name: "Bu Rina", phone: "08123456789", address: "Jl. Melati No. 5, Bandung" },
      requestedDate: "2999-01-02", note: "Kirim pagi",
    });
  });

  it("the outbox payload carries no price, COGS, RRP or margin", async () => {
    const t = setup();
    const so = await makeSo(t, t.quote("approved"));
    const body = t.one<{ body: string }>("SELECT body FROM so_outbox WHERE sales_order_id = ?", so.id).body;
    for (const key of ["cogs", "rrp", "price", "amount", "margin", "total", "list_price", "landed"]) {
      expect(body.toLowerCase()).not.toContain(`"${key}`);
    }
    for (const line of JSON.parse(body).payload.lines) {
      expect(Object.keys(line).sort()).toEqual(["baseQty", "baseUom", "lineNo", "name", "qty", "sku", "uom"]);
    }
  });

  it("held and unmatched lines stay out and come back with their reason; baseQty from the unit factor", async () => {
    const t = setup();
    const r = await t.as(REP)("POST", `/api/quotes/${t.quote("approved")}/sales-order`, {});
    expect(r.status).toBe(201);
    expect(r.json.excluded.map((e: any) => [e.lineNo, e.reason])).toEqual([
      [3, "Ditolak di cek harga sales"],
      [4, "Belum cocok dengan barang katalog"],
    ]);
    const lines = JSON.parse(t.one<{ body: string }>("SELECT body FROM so_outbox").body).payload.lines;
    expect(lines).toEqual([
      { lineNo: 1, sku: "ATK-001", name: "Barang ATK-001", uom: "Box", qty: 2, baseUom: "Pcs", baseQty: 48 },
      { lineNo: 2, sku: "ATK-002", name: "Barang ATK-002", uom: "Pcs", qty: 5, baseUom: "Pcs", baseQty: 5 },
    ]);
  });

  it("every line held or unmatched: 422 and nothing written", async () => {
    const t = setup();
    const q = t.quote("approved", { items: [LINES[2], LINES[3]] });
    const r = await t.as(REP)("POST", `/api/quotes/${q}/sales-order`, {});
    expect(r.status).toBe(422);
    expect(r.json.excluded).toHaveLength(2);
    expect(t.one("SELECT COUNT(*) AS n FROM sales_orders")).toEqual({ n: 0 });
    expect(t.one("SELECT status FROM quotes WHERE id = ?", q)).toEqual({ status: "approved" });
  });

  it("line prices equal the quote's export prices at the selected scenario", async () => {
    const t = setup();
    const q = t.quote("approved", { scenario: 1 });
    const so = await makeSo(t, q);
    const engine = computeEngine(DEFAULT_ASSUMPTIONS, LINES, DEFAULT_REGIONS);
    const lines = JSON.parse(t.one<{ lines: string }>("SELECT lines FROM sales_orders WHERE id = ?", so.id).lines);
    expect(lines.map((l: any) => l.price)).toEqual([engine.rows[0].prices[1], engine.rows[1].prices[1]]);
    expect(lines[1].price).toBe(17_500); // the manual S2 price, not S1 or the RRP
    expect(lines.map((l: any) => l.price)).not.toEqual([engine.rows[0].prices[0], engine.rows[1].prices[0]]);
    expect(t.one("SELECT total_value FROM sales_orders WHERE id = ?", so.id)).toEqual({ total_value: 2 * engine.rows[0].prices[1] + 5 * 17_500 });
    expect(lines[0]).not.toHaveProperty("cogs");
  });

  it.each(["draft", "submitted", "rejected", "lost", "completed"])("from a %s quote: 409", async (status) => {
    const t = setup();
    const r = await t.as(REP)("POST", `/api/quotes/${t.quote(status)}/sales-order`, {});
    expect(r.status).toBe(409);
    expect(t.one("SELECT COUNT(*) AS n FROM sales_orders")).toEqual({ n: 0 });
  });

  it.each(["sent", "won"])("from a %s quote: created, quote ends won", async (status) => {
    const t = setup();
    const q = t.quote(status);
    await makeSo(t, q);
    expect(t.one("SELECT status FROM quotes WHERE id = ?", q)).toEqual({ status: "won" });
  });

  it("a second SO for the same quote: 409", async () => {
    const t = setup();
    const q = t.quote("approved");
    await makeSo(t, q);
    const r = await t.as(REP)("POST", `/api/quotes/${q}/sales-order`, {});
    expect(r.status).toBe(409);
    expect(t.one("SELECT COUNT(*) AS n FROM sales_orders")).toEqual({ n: 1 });
  });

  it("an SO landing between the check and the write: the unique index answers 409, quote untouched", async () => {
    const t = setup();
    const q = t.quote("approved");
    t.race("INSERT INTO sales_orders", () =>
      t.sqlite.exec(`INSERT INTO sales_orders(number, quote_id, quote_rev_no, ship_to_name, ship_to_address, lines, total_value, created_by)
                     VALUES ('HK/SIP/SO/0000/999', ${q}, 1, 'x', 'x', '[]', 0, 1)`),
    );
    const r = await t.as(REP)("POST", `/api/quotes/${q}/sales-order`, {});
    expect(r.status).toBe(409);
    expect(t.one("SELECT COUNT(*) AS n FROM sales_orders")).toEqual({ n: 1 });
    expect(t.one("SELECT COUNT(*) AS n FROM so_outbox")).toEqual({ n: 0 });
    expect(t.one("SELECT status FROM quotes WHERE id = ?", q)).toEqual({ status: "approved" });
  });

  it("the database refuses two active SOs per quote, but allows a new one after a cancelled one", () => {
    const t = setup();
    const q = t.quote("won");
    const ins = (n: string, status = "open") =>
      t.sqlite.exec(`INSERT INTO sales_orders(number, quote_id, quote_rev_no, status, ship_to_name, ship_to_address, lines, total_value, created_by)
                     VALUES ('${n}', ${q}, 1, '${status}', 'x', 'x', '[]', 0, 1)`);
    ins("A", "cancelled");
    ins("B");
    expect(() => ins("C")).toThrow(/UNIQUE/);
    expect(() => ins("D", "cancel_requested")).toThrow(/UNIQUE/);
  });

  it("numbers run HK/SIP/SO/YYMM/NNN; a number taken meanwhile is retried with the next one", async () => {
    const t = setup();
    const a = await makeSo(t, t.quote("approved"));
    const prefix = a.number.slice(0, -3);
    const other = t.quote("won");
    const q = t.quote("approved");
    t.race("INSERT INTO sales_orders", () =>
      t.sqlite.exec(`INSERT INTO sales_orders(number, quote_id, quote_rev_no, ship_to_name, ship_to_address, lines, total_value, created_by)
                     VALUES ('${prefix}002', ${other}, 1, 'x', 'x', '[]', 0, 1)`),
    );
    const b = await makeSo(t, q);
    expect(a.number).toBe(`${prefix}001`);
    expect(b.number).toBe(`${prefix}003`);
  });

  it("someone else's quote: 403; a manager (edit_all_quotes) may", async () => {
    const t = setup();
    const q = t.quote("approved");
    expect((await t.as(OTHER_REP)("POST", `/api/quotes/${q}/sales-order`, {})).status).toBe(403);
    expect((await t.as(MANAGER)("POST", `/api/quotes/${q}/sales-order`, {})).status).toBe(201);
  });

  it("422: no client, client without code, empty ship-to, a past date", async () => {
    const t = setup();
    expect((await t.as(REP)("POST", `/api/quotes/${t.quote("approved", { client: null })}/sales-order`, {})).status).toBe(422);
    expect((await t.as(REP)("POST", `/api/quotes/${t.quote("approved", { client: 11 })}/sales-order`, {})).status).toBe(422);
    const q = t.quote("approved");
    t.sqlite.exec("UPDATE clients SET address = '' WHERE id = 10");
    expect((await t.as(REP)("POST", `/api/quotes/${q}/sales-order`, {})).status).toBe(422);
    expect((await t.as(REP)("POST", `/api/quotes/${q}/sales-order`, { shipToAddress: "Gudang klien, Jl. Baru 1", requestedDate: "2000-01-01" })).status).toBe(422);
    expect((await t.as(REP)("POST", `/api/quotes/${q}/sales-order`, { shipToAddress: "Gudang klien, Jl. Baru 1" })).status).toBe(201);
    expect(t.one("SELECT ship_to_address FROM sales_orders")).toEqual({ ship_to_address: "Gudang klien, Jl. Baru 1" });
  });

  it("schedules a dispatch with waitUntil after answering", async () => {
    const t = setup();
    await makeSo(t, t.quote("approved"));
    expect(t.waits).toHaveLength(1);
    await Promise.all(t.waits);
  });

  it("GET preview: lines, left-out lines, total and ship-to defaults; then the active SO", async () => {
    const t = setup();
    const q = t.quote("approved");
    const p = await t.as(REP)("GET", `/api/quotes/${q}/sales-order`);
    expect(p.json).toMatchObject({ enabled: true, salesOrder: null, canCreate: true, defaults: { shipToName: "Bu Rina", shipToPhone: "08123456789", shipToAddress: "Jl. Melati No. 5, Bandung" } });
    expect(p.json.lines).toHaveLength(2);
    expect(p.json.excluded).toHaveLength(2);
    expect(JSON.stringify(p.json)).not.toContain("cogs");
    const so = await makeSo(t, q);
    expect((await t.as(REP)("GET", `/api/quotes/${q}/sales-order`)).json.salesOrder).toMatchObject({ id: so.id, number: so.number });
  });
});

/* ---------------- saklar ---------------- */

describe("sales_order_enabled switch", () => {
  it.each([["0" as const], [null]])("off (%s): SO routes refuse, preview says disabled, FMS endpoints 503", async (flag) => {
    const t = setup({ flag, env: { FMS_PE_SECRET: FMS_SECRET } });
    const q = t.quote("approved");
    expect((await t.as(REP)("POST", `/api/quotes/${q}/sales-order`, {})).status).toBe(403);
    expect((await t.as(REP)("GET", `/api/quotes/${q}/sales-order`)).json).toEqual({ enabled: false });
    expect((await t.as(REP)("GET", "/api/sales-orders")).status).toBe(403);
    expect((await t.as(REP)("GET", "/api/sales-orders/enabled")).json).toEqual({ enabled: false });
    expect((await signedPost(t, stateEvent("HK/SIP/SO/2611/001", "PACKING", 1))).status).toBe(503);
    expect((await signedGet(t, "/api/integrations/fms/catalog")).status).toBe(503);
    expect(t.one("SELECT COUNT(*) AS n FROM sales_orders")).toEqual({ n: 0 });
  });

  it("off: the dispatcher sends nothing", async () => {
    const t = setup();
    await makeSo(t, t.quote("approved"));
    t.sqlite.exec("UPDATE settings SET value = '0' WHERE key = 'sales_order_enabled'");
    const fms = fakeFms(() => ack());
    expect((await dispatchSoOutbox(dispatchEnv(t), fms.fetcher)).skipped).toBe("disabled");
    expect(fms.calls).toHaveLength(0);
  });
});

/* ---------------- kirim outbox ---------------- */

describe("dispatchSoOutbox", () => {
  it("200 with a valid ack: delivered, SO shows delivered, timeline 'sent'; signed, no redirects, timeout set", async () => {
    const t = setup();
    const so = await makeSo(t, t.quote("approved"));
    const fms = fakeFms(() => ack());
    expect(await dispatchSoOutbox(dispatchEnv(t), fms.fetcher)).toMatchObject({ processed: 1, delivered: 1 });
    expect(fms.calls[0].init.redirect).toBe("manual");
    expect(fms.calls[0].init.signal).toBeInstanceOf(AbortSignal);
    expect(fms.calls[0].body.payload.soNumber).toBe(so.number);
    expect(t.one("SELECT delivered_at IS NOT NULL AS d FROM so_outbox")).toEqual({ d: 1 });
    expect(t.one("SELECT sync_state, sync_error FROM sales_orders")).toEqual({ sync_state: "delivered", sync_error: null });
    expect(t.many("SELECT kind FROM sales_order_events ORDER BY id").map((e) => e.kind)).toEqual(["created", "sent"]);
    // Delivered rows are not sent again.
    expect((await dispatchSoOutbox(dispatchEnv(t), fms.fetcher)).processed).toBe(0);
  });

  it("500: retried with backoff, not delivered; after 3 failures the SO shows 'failed' but keeps retrying", async () => {
    const t = setup();
    await makeSo(t, t.quote("approved"));
    const fms = fakeFms(() => new Response("down", { status: 500 }));
    await dispatchSoOutbox(dispatchEnv(t), fms.fetcher);
    const row = t.one("SELECT attempts, parked, delivered_at, CAST(strftime('%s', next_attempt_at) - strftime('%s', 'now') AS INTEGER) AS wait FROM so_outbox");
    expect(row).toMatchObject({ attempts: 1, parked: 0, delivered_at: null });
    expect(row.wait).toBeGreaterThanOrEqual(29);
    expect(row.wait).toBeLessThanOrEqual(30);
    expect(t.one("SELECT sync_state FROM sales_orders")).toEqual({ sync_state: "pending" });
    // Not due yet: nothing sent.
    expect((await dispatchSoOutbox(dispatchEnv(t), fms.fetcher)).processed).toBe(0);
    for (let i = 0; i < 2; i++) {
      t.sqlite.exec("UPDATE so_outbox SET next_attempt_at = datetime('now', '-1 second')");
      await dispatchSoOutbox(dispatchEnv(t), fms.fetcher);
    }
    expect(t.one("SELECT attempts, parked FROM so_outbox")).toEqual({ attempts: 3, parked: 0 });
    expect(t.one("SELECT sync_state FROM sales_orders").sync_state).toBe("failed");
    expect(t.one("SELECT sync_error FROM sales_orders").sync_error).toContain("HTTP 500");
  });

  it("backoff is min(30 s * 2^(attempts-1), 6 h)", () => {
    expect([1, 2, 3, 4, 10, 11, 20].map(backoffSeconds)).toEqual([30, 60, 120, 240, 15360, 21600, 21600]);
  });

  it.each([400, 413, 422])("%i: parked, not retried, SO 'failed'", async (status) => {
    const t = setup();
    await makeSo(t, t.quote("approved"));
    const fms = fakeFms(() => Response.json({ error: "skema" }, { status }));
    expect(await dispatchSoOutbox(dispatchEnv(t), fms.fetcher)).toMatchObject({ parked: 1 });
    expect(t.one("SELECT parked, delivered_at FROM so_outbox")).toEqual({ parked: 1, delivered_at: null });
    expect(t.one("SELECT sync_state FROM sales_orders")).toEqual({ sync_state: "failed" });
    t.sqlite.exec("UPDATE so_outbox SET next_attempt_at = datetime('now', '-1 hour')");
    expect((await dispatchSoOutbox(dispatchEnv(t), fms.fetcher)).processed).toBe(0);
  });

  it("401: parked and an admin warning (log + audit)", async () => {
    const t = setup();
    const so = await makeSo(t, t.quote("approved"));
    const warn = vi.spyOn(console, "error").mockImplementation(() => undefined);
    // FMS holds a different secret: our signature fails its check.
    const fms = fakeFms(() => ack());
    await dispatchSoOutbox(dispatchEnv(t, { PE_FMS_SECRET: "x".repeat(40) }), fms.fetcher);
    expect(t.one("SELECT parked FROM so_outbox")).toEqual({ parked: 1 });
    expect(warn.mock.calls.some((c) => String(c[0]).includes("PERINGATAN ADMIN"))).toBe(true);
    expect(t.one("SELECT COUNT(*) AS n FROM audit_log WHERE entity = 'sales_order' AND entity_id = ? AND action = 'fms_auth_rejected'", so.id)).toEqual({ n: 1 });
  });

  it("200 without a valid ack, a redirect, or a network error: retried, never delivered", async () => {
    for (const reply of [
      () => new Response("ok", { status: 200 }),
      () => Response.json({ duplicate: false, applied: true }),
      () => new Response(null, { status: 302, headers: { location: "https://elsewhere" } }),
      () => Promise.reject(new TypeError("fetch failed")),
    ]) {
      const t = setup();
      await makeSo(t, t.quote("approved"));
      const fms = fakeFms(reply as () => Response);
      expect(await dispatchSoOutbox(dispatchEnv(t), fms.fetcher)).toMatchObject({ retried: 1, delivered: 0 });
      expect(t.one("SELECT attempts, parked, delivered_at FROM so_outbox")).toEqual({ attempts: 1, parked: 0, delivered_at: null });
    }
  });

  it.each([
    ["no secret", { PE_FMS_SECRET: undefined }],
    ["a short secret", { PE_FMS_SECRET: "short-secret" }],
    ["no URL", { FMS_SO_URL: undefined }],
    ["plain HTTP to another host", { FMS_SO_URL: "http://fms.example/hook" }],
  ])("%s: fails closed, nothing sent", async (_name, over) => {
    const t = setup();
    await makeSo(t, t.quote("approved"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fms = fakeFms(() => ack());
    expect((await dispatchSoOutbox(dispatchEnv(t, over as Partial<Bindings>), fms.fetcher)).skipped).toBe("config");
    expect(fms.calls).toHaveLength(0);
  });

  it("HTTP to localhost is allowed for development", async () => {
    const t = setup();
    await makeSo(t, t.quote("approved"));
    const fms = fakeFms(() => ack());
    expect((await dispatchSoOutbox(dispatchEnv(t, { FMS_SO_URL: "http://127.0.0.1:3000/api/webhooks/pricing-engine" }), fms.fetcher)).delivered).toBe(1);
  });

  it("a cancel is not sent before its order is delivered", async () => {
    const t = setup();
    const so = await makeSo(t, t.quote("approved"));
    expect((await t.as(REP)("POST", `/api/sales-orders/${so.id}/cancel`, { reason: "Klien membatalkan PO" })).status).toBe(200);
    const fail = fakeFms(() => new Response("down", { status: 503 }));
    await dispatchSoOutbox(dispatchEnv(t), fail.fetcher);
    expect(fail.calls.map((c) => c.body.type)).toEqual(["sales_order.created"]);
    t.sqlite.exec("UPDATE so_outbox SET next_attempt_at = datetime('now', '-1 second')");
    const ok = fakeFms(() => ack());
    await dispatchSoOutbox(dispatchEnv(t), ok.fetcher);
    expect(ok.calls.map((c) => [c.body.type, c.body.sequence])).toEqual([
      ["sales_order.created", 1],
      ["sales_order.cancel_requested", 2],
    ]);
  });
});

/* ---------------- batal SO ---------------- */

describe("cancel", () => {
  it("open -> cancel_requested with a cancel event; FMS CANCELLED makes it final", async () => {
    const t = setup({ env: { FMS_PE_SECRET: FMS_SECRET } });
    const so = await makeSo(t, t.quote("approved"));
    const r = await t.as(REP)("POST", `/api/sales-orders/${so.id}/cancel`, { reason: "Klien membatalkan PO" });
    expect(r.status).toBe(200);
    expect(t.one("SELECT status FROM sales_orders")).toEqual({ status: "cancel_requested" });
    const ev = JSON.parse(t.one<{ body: string }>("SELECT body FROM so_outbox WHERE type = 'sales_order.cancel_requested'").body);
    expect(peEventSchema.safeParse(ev).success).toBe(true);
    expect(ev.payload).toEqual({ soNumber: so.number, reason: "Klien membatalkan PO" });
    expect(t.one("SELECT COUNT(*) AS n FROM audit_log WHERE entity = 'sales_order' AND action = 'cancel_requested'")).toEqual({ n: 1 });

    expect((await t.as(REP)("POST", `/api/sales-orders/${so.id}/cancel`, { reason: "lagi" })).status).toBe(409);
    expect((await signedPost(t, stateEvent(so.number, "CANCELLED", 1, "READY_TO_PACK", "Dibatalkan PE"))).status).toBe(200);
    expect(t.one("SELECT status, fulfillment_state FROM sales_orders")).toEqual({ status: "cancelled", fulfillment_state: "cancelled" });
  });

  it("an ack applied:false puts the SO back to open with the reason", async () => {
    const t = setup();
    const so = await makeSo(t, t.quote("approved"));
    await t.as(REP)("POST", `/api/sales-orders/${so.id}/cancel`, { reason: "Klien membatalkan PO" });
    const fms = fakeFms((body) => (body.type === "sales_order.cancel_requested" ? ack({ applied: false, reason: "sudah diserahkan" }) : ack()));
    await dispatchSoOutbox(dispatchEnv(t), fms.fetcher);
    expect(t.one("SELECT status, sync_error FROM sales_orders")).toEqual({ status: "open", sync_error: "sudah diserahkan" });
    const rejected = t.one<{ detail: string }>("SELECT detail FROM sales_order_events WHERE kind = 'cancel_rejected'");
    expect(JSON.parse(rejected.detail)).toEqual({ reason: "sudah diserahkan" });
  });

  it("someone else's SO: 403; no reason: 422", async () => {
    const t = setup();
    const so = await makeSo(t, t.quote("approved"));
    expect((await t.as(OTHER_REP)("POST", `/api/sales-orders/${so.id}/cancel`, { reason: "Klien membatalkan PO" })).status).toBe(403);
    expect((await t.as(REP)("POST", `/api/sales-orders/${so.id}/cancel`, {})).status).toBe(422);
    expect(t.one("SELECT status FROM sales_orders")).toEqual({ status: "open" });
  });

  it("reopening a quote with an active SO: 409; after the SO is cancelled it may reopen", async () => {
    const t = setup({ env: { FMS_PE_SECRET: FMS_SECRET } });
    const q = t.quote("approved");
    const so = await makeSo(t, q);
    const r = await t.as(REP)("POST", `/api/quotes/${q}/reopen`);
    expect(r.status).toBe(409);
    expect(r.json.error).toContain("Batalkan SO dulu");
    await t.as(REP)("POST", `/api/sales-orders/${so.id}/cancel`, { reason: "Klien membatalkan PO" });
    expect((await t.as(REP)("POST", `/api/quotes/${q}/reopen`)).status).toBe(409);
    await signedPost(t, stateEvent(so.number, "CANCELLED", 1));
    expect((await t.as(REP)("POST", `/api/quotes/${q}/reopen`)).status).toBe(200);
  });
});

/* ---------------- kirim ulang ---------------- */

describe("resend", () => {
  it("only manage_policy; puts parked events back in line", async () => {
    const t = setup();
    const so = await makeSo(t, t.quote("approved"));
    await dispatchSoOutbox(dispatchEnv(t), fakeFms(() => Response.json({}, { status: 422 })).fetcher);
    expect((await t.as(MANAGER)("POST", `/api/sales-orders/${so.id}/resend`)).status).toBe(403);
    const detail = await t.as(ADMIN)("GET", `/api/sales-orders/${so.id}`);
    expect(detail.json).toMatchObject({ parked: 1, canResend: true });
    expect((await t.as(ADMIN)("POST", `/api/sales-orders/${so.id}/resend`)).status).toBe(200);
    expect(t.one("SELECT parked, attempts FROM so_outbox")).toEqual({ parked: 0, attempts: 0 });
    expect(t.one("SELECT sync_state FROM sales_orders")).toEqual({ sync_state: "pending" });
    const fms = fakeFms(() => ack());
    expect((await dispatchSoOutbox(dispatchEnv(t), fms.fetcher)).delivered).toBe(1);
  });
});

/* ---------------- daftar dan detail ---------------- */

describe("GET /api/sales-orders", () => {
  it("lists and shows SOs with lines, timeline, and no COGS", async () => {
    const t = setup();
    const so = await makeSo(t, t.quote("approved"));
    const list = await t.as(OTHER_REP)("GET", "/api/sales-orders");
    expect(list.json.salesOrders).toHaveLength(1);
    expect(list.json.salesOrders[0]).toMatchObject({ number: so.number, client_name: "PT Contoh", status: "open", sync_state: "pending" });
    const d = await t.as(OTHER_REP)("GET", `/api/sales-orders/${so.id}`);
    expect(d.json).toMatchObject({ canCancel: false, canResend: false });
    expect(d.json.salesOrder.lines).toHaveLength(2);
    expect(d.json.events.map((e: any) => e.kind)).toEqual(["created"]);
    expect(JSON.stringify(d.json)).not.toMatch(/cogs|landed|margin/i);
    expect((await t.as(REP)("GET", `/api/sales-orders/${so.id}`)).json.canCancel).toBe(true);
  });
});

/* ---------------- event dari FMS ---------------- */

let eventCounter = 0;
function stateEvent(soNumber: string, state: string, sequence: number, prevState = "READY_TO_PACK", reason: string | null = null) {
  eventCounter++;
  return {
    v: 1,
    eventId: `00000000-0000-4000-8000-${String(eventCounter).padStart(12, "0")}`,
    sequence,
    type: "outbound.state_changed",
    occurredAt: "2026-11-16T16:30:00Z",
    payload: { soNumber, outboundRef: "DO-20261116-0001", prevState, state, reason, courier: null, tracking: null, manifestNo: null },
  };
}

async function signedPost(t: T, event: unknown, o: { secret?: string; ts?: number; body?: string } = {}) {
  const body = o.body ?? JSON.stringify(event);
  const ts = String(o.ts ?? Math.floor(Date.now() / 1000));
  const sig = await signHex(o.secret ?? FMS_SECRET, `${ts}.${body}`);
  const r = await t.raw("/api/integrations/fms/events", {
    method: "POST",
    body,
    headers: { "content-type": "application/json", "x-fms-timestamp": ts, "x-fms-signature": sig },
  });
  return { status: r.status, json: (await r.json()) as Record<string, any> };
}

async function signedGet(t: T, pathAndQuery: string, o: { secret?: string; signedPath?: string } = {}) {
  const ts = String(Math.floor(Date.now() / 1000));
  const u = new URL(o.signedPath ?? pathAndQuery, "http://localhost");
  const sig = await signHex(o.secret ?? FMS_SECRET, `${ts}.GET ${u.pathname}?${u.search.slice(1)}`);
  const r = await t.raw(pathAndQuery, { headers: { "x-fms-timestamp": ts, "x-fms-signature": sig } });
  return { status: r.status, json: (await r.json()) as Record<string, any> };
}

describe("POST /api/integrations/fms/events", () => {
  async function withSo(env: Partial<Bindings> = { FMS_PE_SECRET: FMS_SECRET }) {
    const t = setup({ env });
    const so = await makeSo(t, t.quote("approved"));
    return { t, so };
  }

  it("applies a state change: fulfillment, outbound ref, sequence, timeline and audit", async () => {
    const { t, so } = await withSo();
    const r = await signedPost(t, stateEvent(so.number, "PACKING", 5));
    expect(r).toEqual({ status: 200, json: { received: true, duplicate: false, applied: true } });
    expect(t.one("SELECT status, fulfillment_state, fms_outbound_ref, last_fms_sequence FROM sales_orders")).toEqual({
      status: "open", fulfillment_state: "packing", fms_outbound_ref: "DO-20261116-0001", last_fms_sequence: 5,
    });
    expect(t.one("SELECT COUNT(*) AS n FROM sales_order_events WHERE kind = 'fms_state'")).toEqual({ n: 1 });
    expect(t.one("SELECT COUNT(*) AS n FROM audit_log WHERE entity = 'sales_order' AND action = 'fms_state'")).toEqual({ n: 1 });
  });

  it("TUNDA: on hold with the reason; HANDED_OVER: SO shipped", async () => {
    const { t, so } = await withSo();
    await signedPost(t, stateEvent(so.number, "TUNDA", 1, "PACKING", "Stok kurang"));
    expect(t.one("SELECT fulfillment_state, fulfillment_reason FROM sales_orders")).toEqual({ fulfillment_state: "on_hold", fulfillment_reason: "Stok kurang" });
    await signedPost(t, stateEvent(so.number, "HANDED_OVER", 2, "HANDING_OVER"));
    expect(t.one("SELECT status, fulfillment_state FROM sales_orders")).toEqual({ status: "shipped", fulfillment_state: "shipped" });
  });

  it("the same eventId again: duplicate, nothing changes", async () => {
    const { t, so } = await withSo();
    const e = stateEvent(so.number, "PACKING", 1);
    await signedPost(t, e);
    const before = t.one("SELECT * FROM sales_orders");
    const r = await signedPost(t, e);
    expect(r.json).toEqual({ received: true, duplicate: true, applied: true });
    expect(t.one("SELECT * FROM sales_orders")).toEqual(before);
    expect(t.one("SELECT COUNT(*) AS n FROM sales_order_events WHERE kind = 'fms_state'")).toEqual({ n: 1 });
  });

  it("an older sequence is acknowledged and ignored", async () => {
    const { t, so } = await withSo();
    await signedPost(t, stateEvent(so.number, "AWAITING_HANDOVER", 7, "PACKING"));
    const r = await signedPost(t, stateEvent(so.number, "PACKING", 6));
    expect(r.json).toEqual({ received: true, duplicate: false, applied: false, reason: "event lama" });
    expect(t.one("SELECT fulfillment_state, last_fms_sequence FROM sales_orders")).toEqual({ fulfillment_state: "packed", last_fms_sequence: 7 });
  });

  it("refuses: wrong signature 401, expired 401, no timestamp 401, too big 413, bad JSON 400, bad schema 422, unknown SO 422", async () => {
    const { t, so } = await withSo();
    const e = stateEvent(so.number, "PACKING", 1);
    expect((await signedPost(t, e, { secret: "z".repeat(40) })).status).toBe(401);
    expect((await signedPost(t, e, { ts: Math.floor(Date.now() / 1000) - 301 })).status).toBe(401);
    const noTs = await t.raw("/api/integrations/fms/events", { method: "POST", body: JSON.stringify(e), headers: { "x-fms-signature": "a".repeat(64) } });
    expect(noTs.status).toBe(401);
    expect((await signedPost(t, null, { body: "x".repeat(256 * 1024 + 1) })).status).toBe(413);
    expect((await signedPost(t, null, { body: "{nope" })).status).toBe(400);
    const invalid = JSON.parse(readFileSync(path.resolve(import.meta.dirname, "../../contract-fixtures/invalid-outbound-state-changed-unknown-state.json"), "utf8"));
    expect((await signedPost(t, invalid)).status).toBe(422);
    expect((await signedPost(t, stateEvent("HK/SIP/SO/0000/404", "PACKING", 1))).status).toBe(422);
    expect(t.one("SELECT fulfillment_state FROM sales_orders")).toEqual({ fulfillment_state: null });
    expect(t.one("SELECT COUNT(*) AS n FROM fms_inbox")).toEqual({ n: 0 });
  });

  it.each([["no secret", {}], ["a short secret", { FMS_PE_SECRET: "short" }]])("%s: 503, fails closed", async (_n, env) => {
    const { t, so } = await withSo(env);
    expect((await signedPost(t, stateEvent(so.number, "PACKING", 1), { secret: "short" })).status).toBe(503);
  });

  it("a fixture event from contract-fixtures/ is applied", async () => {
    const t = setup({ env: { FMS_PE_SECRET: FMS_SECRET } });
    const fixture = JSON.parse(readFileSync(path.resolve(import.meta.dirname, "../../contract-fixtures/valid-outbound-state-changed-packing.json"), "utf8"));
    const so = await makeSo(t, t.quote("approved"));
    fixture.payload.soNumber = so.number;
    expect((await signedPost(t, fixture)).json).toMatchObject({ applied: true });
  });
});

/* ---------------- F4b: katalog dan klien untuk FMS ---------------- */

describe("GET /api/integrations/fms/catalog and /clients", () => {
  const t0 = () => setup({ env: { FMS_PE_SECRET: FMS_SECRET } });

  it("catalog: code, name, unit, category and units only — no COGS, price or stock", async () => {
    const t = t0();
    const r = await signedGet(t, "/api/integrations/fms/catalog");
    expect(r.status).toBe(200);
    expect(r.json.items.map((i: any) => i.code)).toEqual(["ATK-001", "ATK-002", "ATK-003"]);
    expect(Object.keys(r.json.items[0]).sort()).toEqual(["category", "code", "name", "uom", "updated_at"]);
    expect(r.json.items[0].updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(r.json.uoms).toEqual([{ code: "ATK-001", uom: "Box", factor: 24 }]);
    expect(r.json.nextCursor).toBeNull();
    expect(JSON.stringify(r.json)).not.toMatch(/cogs|list_price|stock/);
    expect(catalogPageSchema.safeParse(r.json).success).toBe(true);
  });

  it("catalog pages by cursor and filters by since", async () => {
    const t = t0();
    const p1 = await signedGet(t, "/api/integrations/fms/catalog?limit=2");
    expect(p1.json.items).toHaveLength(2);
    const p2 = await signedGet(t, `/api/integrations/fms/catalog?limit=2&cursor=${p1.json.nextCursor}`);
    expect(p2.json.items.map((i: any) => i.code)).toEqual(["ATK-003"]);
    expect(p2.json.nextCursor).toBeNull();
    t.sqlite.exec("UPDATE catalog_items SET updated_at = '2020-01-01 00:00:00' WHERE code <> 'ATK-002'");
    const since = await signedGet(t, "/api/integrations/fms/catalog?since=2025-01-01T00:00:00Z");
    expect(since.json.items.map((i: any) => i.code)).toEqual(["ATK-002"]);
    expect((await signedGet(t, "/api/integrations/fms/catalog?since=kemarin")).status).toBe(400);
  });

  it("clients: an edited client shows up after since", async () => {
    const t = t0();
    t.sqlite.exec("UPDATE clients SET updated_at = '2020-01-01 00:00:00'");
    expect((await signedGet(t, "/api/integrations/fms/clients?since=2025-01-01T00:00:00Z")).json.clients).toEqual([]);
    const put = await t.as(REP)("PUT", "/api/clients/10", { name: "PT Contoh Baru", code: "C001", address: "Jl. Melati No. 5, Bandung", contact_name: "Bu Rina", contact_email: "", contact_phone: "08123456789", payment_terms: "30 hari", delivery_terms: "Franco" });
    expect(put.status).toBe(200);
    const r = await signedGet(t, "/api/integrations/fms/clients?since=2025-01-01T00:00:00Z");
    expect(r.json.clients).toHaveLength(1);
    expect(Object.keys(r.json.clients[0]).sort()).toEqual(["address", "code", "contact_name", "contact_phone", "name", "updated_at"]);
    expect(r.json.clients[0].name).toBe("PT Contoh Baru");
    expect(clientsPageSchema.safeParse(r.json).success).toBe(true);
  });

  it("refuses a wrong secret, a signature over another query, and no secret configured", async () => {
    const t = t0();
    expect((await signedGet(t, "/api/integrations/fms/catalog", { secret: "z".repeat(40) })).status).toBe(401);
    expect((await signedGet(t, "/api/integrations/fms/catalog?limit=500&since=2000-01-01T00:00:00Z", { signedPath: "/api/integrations/fms/catalog?limit=500" })).status).toBe(401);
    expect((await signedGet(t, "/api/integrations/fms/clients", { secret: "z".repeat(40) })).status).toBe(401);
    const bare = setup();
    expect((await signedGet(bare, "/api/integrations/fms/catalog")).status).toBe(503);
  });
});
