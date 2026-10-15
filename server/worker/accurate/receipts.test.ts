import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { D1DatabaseShim } from "../../../scripts/d1-sqlite-shim";
import { isoDate, mapReceipt, mapReceiptLines, updateKey } from "./mapping";
import { RECEIPTS_CRON, receiptConfig, receiptStep, wibTimestamp, type ReceiptConfig } from "./receipts";
import { syncConfig } from "./sync";
import { accurateRouter } from "../routes/accurate";
import { PAID_PLAN, countQueries, fakeAccurate, type FakeReceipt } from "./testing";
import type { Env } from "../env";

function freshDb() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = path.resolve(import.meta.dirname, "../../../migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(path.join(dir, f), "utf8"));
  return { sqlite, db: new D1DatabaseShim(sqlite) as unknown as D1Database };
}

const creds = { token: "aat.test", signatureSecret: "secret" };
const cfg: ReceiptConfig = { pageSize: 3, everyHours: 6, since: "01/01/2026" };

/** The two receipts of 101311 in Accurate's Mutasi tab (21-22 Mei 2026), plus others. */
const RECEIPTS: FakeReceipt[] = [
  { id: 501, number: "RI.2026.05.00021", transDate: "21/05/2026", lastUpdate: "21/05/2026 10:00:00", status: "BILLED",
    detailItem: [{ id: 1, item: { no: "101311" }, itemUnit: { name: "Pcs" }, quantity: 1, unitPrice: 10_657_600 }] },
  { id: 502, number: "RI.2026.05.00022", transDate: "22/05/2026", lastUpdate: "22/05/2026 09:30:00", status: "RECEIVED",
    detailItem: [
      { id: 1, itemNo: "101311", itemUnitName: "Pcs", quantity: 1, unitPrice: 11_005_000 },
      { id: 2, itemNo: "A1", itemUnitName: "Box", quantity: 2, unitPrice: 120_000 },
    ] },
  { id: 503, number: "RI.DRAFT", transDate: "23/05/2026", lastUpdate: "23/05/2026 08:00:00", status: "DRAFT",
    detailItem: [{ id: 1, itemNo: "101311", itemUnitName: "Pcs", quantity: 1, unitPrice: 1 }] },
  { id: 504, number: "RI.2026.06.00001", transDate: "02/06/2026", lastUpdate: "02/06/2026 11:00:00", status: "RECEIVED",
    detailItem: [{ id: 1, itemNo: "B1", itemUnitName: "Lusin", quantity: 1, unitPrice: 30_000 }] },
];

async function runPass(db: D1Database, f: typeof fetch, budget = 5, c = cfg) {
  const outcomes: string[] = [];
  for (let i = 0; i < 50; i++) {
    const r = await receiptStep(db, "PT", creds, c, { budget, deadline: Date.now() + 10_000, fetchImpl: f, gapMs: 0 });
    outcomes.push(r.outcome);
    if (r.outcome === "error") throw new Error(r.error);
    if (r.outcome === "finished") break;
  }
  return outcomes;
}

describe("receipt mapping", () => {
  it("reads flat and nested line shapes and Accurate dates", () => {
    expect(isoDate("2/6/2026")).toBe("2026-06-02");
    expect(updateKey("02/06/2026 9:05:01")).toBe("2026-06-02 09:05:01");
    expect(updateKey("21/05/2026 10:00:00") < updateKey("02/06/2026 00:00:00")).toBe(true);
    expect(mapReceipt({ id: 1, number: "RI.1", status: "draft" })).toMatchObject({ received: false });
    expect(mapReceipt({ id: 2, number: "RI.2", status: "PARTIAL_BILLED" })).toMatchObject({ received: true });
    expect(mapReceiptLines({ ...RECEIPTS[1], detailItem: [...RECEIPTS[1].detailItem, { id: 9, quantity: 1 }] })).toEqual([
      { receiptId: 502, lineId: 1, receiptNo: "RI.2026.05.00022", transDate: "2026-05-22", itemCode: "101311", unit: "Pcs", quantity: 1, unitPrice: 11_005_000 },
      { receiptId: 502, lineId: 2, receiptNo: "RI.2026.05.00022", transDate: "2026-05-22", itemCode: "A1", unit: "Box", quantity: 2, unitPrice: 120_000 },
    ]);
  });
});

describe("receiptStep", () => {
  it("reads every received receipt over several small ticks, skipping drafts", async () => {
    const { sqlite, db } = freshDb();
    const fake = fakeAccurate({ items: [], stock: {}, receipts: RECEIPTS });
    // Budget 2 = one listing + one detail per tick: progress must be per receipt, not per page.
    const outcomes = await runPass(db, fake.impl, 2);
    expect(outcomes.at(-1)).toBe("finished");
    expect(outcomes.length).toBeGreaterThan(2);
    expect(sqlite.prepare("SELECT receipt_no, item_code, unit, unit_price FROM accurate_receipt_lines ORDER BY receipt_id, line_id").all()).toEqual([
      { receipt_no: "RI.2026.05.00021", item_code: "101311", unit: "Pcs", unit_price: 10_657_600 },
      { receipt_no: "RI.2026.05.00022", item_code: "101311", unit: "Pcs", unit_price: 11_005_000 },
      { receipt_no: "RI.2026.05.00022", item_code: "A1", unit: "Box", unit_price: 120_000 },
      { receipt_no: "RI.2026.06.00001", item_code: "B1", unit: "Lusin", unit_price: 30_000 },
    ]);
    expect(fake.log.filter((l) => l.includes("detail.do"))).toHaveLength(3); // never the draft
    expect(sqlite.prepare("SELECT since_update, pass_started_at FROM accurate_receipt_state").get()).toEqual({
      since_update: "02/06/2026 11:00:00",
      pass_started_at: null,
    });
    // Not due again until everyHours have passed.
    const r = await receiptStep(db, "PT", creds, cfg, { budget: 5, deadline: Date.now() + 5000, fetchImpl: fake.impl, gapMs: 0 });
    expect(r.outcome).toBe("idle");
  });

  it("a later pass re-reads only changed receipts and replaces their lines whole", async () => {
    const { sqlite, db } = freshDb();
    const receipts = structuredClone(RECEIPTS);
    const fake = fakeAccurate({ items: [], stock: {}, receipts });
    await runPass(db, fake.impl);
    // In Accurate: RI.00022 edited (line A1 removed, price corrected), the draft rejected later.
    receipts[1].lastUpdate = "05/06/2026 08:00:00";
    receipts[1].detailItem = [{ id: 1, itemNo: "101311", itemUnitName: "Pcs", quantity: 1, unitPrice: 11_100_000 }];
    sqlite.exec("UPDATE accurate_receipt_state SET last_pass_at = '2000-01-01T00:00:00Z'");
    fake.log.length = 0;
    await runPass(db, fake.impl);
    expect(fake.log.filter((l) => l.includes("detail.do"))).toHaveLength(2); // RI.00022 and the boundary receipt RI.2026.06.00001
    expect(sqlite.prepare("SELECT item_code, unit_price FROM accurate_receipt_lines WHERE receipt_id = 502").all()).toEqual([
      { item_code: "101311", unit_price: 11_100_000 },
    ]);
  });

  it("a first pass spanning several days keeps the start date it began with", async () => {
    // The default start is "one year back" from each tick's clock; a backfill takes days,
    // so a later tick's start date moves past receipts on pages the pass hasn't reached.
    const { sqlite, db } = freshDb();
    const fake = fakeAccurate({ items: [], stock: {}, receipts: RECEIPTS });
    const day1: ReceiptConfig = { ...cfg, since: "21/05/2026" };
    const day2: ReceiptConfig = { ...cfg, since: "22/05/2026" }; // would drop RI.00021 and shift the pages
    await receiptStep(db, "PT", creds, day1, { budget: 2, deadline: Date.now() + 5000, fetchImpl: fake.impl, gapMs: 0 });
    await runPass(db, fake.impl, 2, day2);
    expect(sqlite.prepare("SELECT DISTINCT receipt_no FROM accurate_receipt_lines ORDER BY receipt_id").all().map((r: any) => r.receipt_no)).toEqual([
      "RI.2026.05.00021",
      "RI.2026.05.00022",
      "RI.2026.06.00001",
    ]);
  });

  it("keeps the cursor and records the error when Accurate fails mid-pass", async () => {
    const { sqlite, db } = freshDb();
    const fake = fakeAccurate({ items: [], stock: {}, receipts: RECEIPTS });
    let n = 0;
    const flaky: typeof fetch = (u, i) => (String(u).includes("detail.do") && ++n === 2 ? Promise.resolve(new Response("{}", { status: 500 })) : fake.impl(u, i));
    const r = await receiptStep(db, "PT", creds, cfg, { budget: 10, deadline: Date.now() + 5000, fetchImpl: flaky, gapMs: 0 });
    expect(r.outcome).toBe("error");
    expect(sqlite.prepare("SELECT page, row_idx, last_error IS NOT NULL AS err FROM accurate_receipt_state").get()).toEqual({ page: 1, row_idx: 0, err: 1 });
    expect((await runPass(db, fake.impl)).at(-1)).toBe("finished");
    expect(sqlite.prepare("SELECT last_error FROM accurate_receipt_state").get()).toEqual({ last_error: null });
  });

  it("with the deployed settings every receipts tick stays within the plan's subrequests and D1 queries", async () => {
    const toml = readFileSync(new URL("../../../wrangler.toml", import.meta.url), "utf8");
    const v = (k: string) => toml.match(new RegExp(`^${k}\\s*=\\s*"([^"]*)"`, "m"))?.[1];
    const { db: raw } = freshDb();
    const { db, queries, reset } = countQueries(raw);
    const many: FakeReceipt[] = Array.from({ length: 137 }, (_, i) => ({
      id: 1000 + i, number: `RI.${i}`, transDate: "10/07/2026", lastUpdate: "10/07/2026 10:00:00", status: "RECEIVED",
      detailItem: Array.from({ length: 30 }, (_, j) => ({ id: j + 1, itemNo: `C${j}`, itemUnitName: "Pcs", quantity: 2, unitPrice: 1000 + j })),
    }));
    const fake = fakeAccurate({ items: [], stock: {}, receipts: many });
    let calls = 0;
    const counted: typeof fetch = (u, i) => (calls++, fake.impl(u, i));
    const env = { ACCURATE_CALLS_PER_TICK: v("ACCURATE_CALLS_PER_TICK"), ACCURATE_RECEIPTS_PAGE_SIZE: v("ACCURATE_RECEIPTS_PAGE_SIZE") } as never;
    const budget = syncConfig(env).callsPerTick;
    const c = receiptConfig(env);
    let worst = 0;
    let worstQueries = 0;
    let finished = false;
    for (let t = 0; t < 400 && !finished; t++) {
      calls = 0;
      reset();
      const r = await receiptStep(db, "PT", creds, c, { budget, deadline: Date.now() + 10_000, fetchImpl: counted, gapMs: 0 });
      if (r.outcome === "error") throw new Error(r.error);
      worst = Math.max(worst, calls + queries());
      worstQueries = Math.max(worstQueries, queries());
      finished = r.outcome === "finished";
    }
    expect(finished).toBe(true);
    expect(worst).toBeLessThanOrEqual(PAID_PLAN.subrequests);
    expect(worstQueries).toBeLessThanOrEqual(PAID_PLAN.d1Queries);
    expect(budget).toBe(60);
    expect(["true", "false"]).toContain(v("ACCURATE_RECEIPTS_ENABLED"));
  });

  it("wrangler.toml schedules the receipts cron verbatim (a mismatch would run the item sync twice as often)", () => {
    const toml = readFileSync(new URL("../../../wrangler.toml", import.meta.url), "utf8");
    expect(toml).toContain(`"${RECEIPTS_CRON}"`);
  });

  it("formats the lastUpdate filter in WIB", () => {
    expect(wibTimestamp(new Date("2026-10-15T17:05:09Z"))).toBe("16/10/2026 00:05:09");
  });
});

describe("POST /api/accurate/apply-cogs", () => {
  function setup(role = "manager") {
    const { sqlite, db } = freshDb();
    sqlite.exec(`INSERT INTO users(id, email, name, password_hash, role) VALUES (1, 'm@x', 'M', 'x', '${role}')`);
    sqlite.exec(`INSERT INTO catalog_items(code, name, uom, cogs, list_price, stock) VALUES
      ('101311', 'Keset', 'Pcs', 10831300, 12000000, 0),
      ('A1', 'Kertas', 'Pcs', 9000, 15000, 0),
      ('B1', 'Spidol', 'Pcs', 2000, 3000, 0),
      ('C1', 'Map', 'Box', 50000, 60000, 0),
      ('N1', 'Belum pernah dibeli', 'Pcs', 700, 1000, 0)`);
    sqlite.exec(`INSERT INTO accurate_items(entity, accurate_id, code, name, uom, units, run_id) VALUES
      ('PT', 1, '101311', 'Keset', 'Pcs', '[]', 'r'),
      ('PT', 2, 'A1', 'Kertas', 'Pcs', '[{"uom":"Box","factor":12}]', 'r'),
      ('PT', 3, 'B1', 'Spidol', 'Pcs', '[]', 'r'),
      ('PT', 4, 'C1', 'Map', 'Pcs', '[]', 'r'),
      ('PT', 5, 'N1', 'Belum pernah dibeli', 'Pcs', '[]', 'r')`);
    sqlite.exec(`INSERT INTO accurate_receipt_lines(entity, receipt_id, line_id, receipt_no, trans_date, item_code, unit, quantity, unit_price) VALUES
      ('PT', 501, 1, 'RI.2026.05.00021', '2026-05-21', '101311', 'Pcs', 1, 10657600),
      ('PT', 502, 1, 'RI.2026.05.00022', '2026-05-22', '101311', 'Pcs', 1, 11005000),
      ('PT', 502, 2, 'RI.2026.05.00022', '2026-05-22', 'A1', 'Box', 2, 120000),
      ('PT', 504, 1, 'RI.2026.06.00001', '2026-06-02', 'B1', 'Lusin', 1, 30000),
      ('PT', 505, 1, 'RI.2026.06.00002', '2026-06-03', 'C1', 'Pcs', 1, 4000)`);
    const app = new Hono<Env>();
    app.use(async (c, next) => {
      c.set("user", { id: 1, email: "m@x", name: "M", role } as never);
      await next();
    });
    app.route("/api/accurate", accurateRouter);
    const env = { DB: db } as unknown as Env["Bindings"];
    const post = (body: unknown) =>
      app.request("/api/accurate/apply-cogs", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }, env);
    const get = (p: string) => app.request(p, {}, env);
    const cogs = () => Object.fromEntries((sqlite.prepare("SELECT code, cogs FROM catalog_items").all() as { code: string; cogs: number }[]).map((r) => [r.code, r.cogs]));
    return { sqlite, post, get, cogs };
  }

  it("waits for a complete receipts pass", async () => {
    const { post } = setup();
    expect((await post({})).status).toBe(409);
  });

  it("previews by default, then sets COGS to the last purchase price per catalog unit", async () => {
    const { sqlite, post, cogs } = setup();
    sqlite.exec("INSERT INTO accurate_receipt_state(entity, last_pass_at, since_update) VALUES ('PT', '2026-10-15T08:00:00Z', '03/06/2026 10:00:00')");
    const before = cogs();

    const preview = (await (await post({})).json()) as any;
    expect(preview.dryRun).toBe(true);
    expect(cogs()).toEqual(before);
    expect(preview.changed).toEqual([
      { code: "101311", name: "Keset", from: 10_831_300, to: 11_005_000, receiptNo: "RI.2026.05.00022", transDate: "2026-05-22" },
      { code: "A1", name: "Kertas", from: 9000, to: 10_000, receiptNo: "RI.2026.05.00022", transDate: "2026-05-22" },
    ]);
    expect(preview.skipped.map((s: any) => [s.code, s.reason])).toEqual([
      ["B1", "unknown_unit"], // Lusin has no ratio in Accurate
      ["C1", "uom_mismatch"], // catalog keeps Box, Accurate's base unit is Pcs
    ]);
    expect(preview.noReceipt).toBe(1);

    const applied = await post({ dryRun: false });
    expect(applied.status).toBe(200);
    expect(cogs()).toEqual({ ...before, "101311": 11_005_000, A1: 10_000 });
    // The reference doesn't move (0010): only a manager's "COGS ini benar" does.
    expect(sqlite.prepare("SELECT cogs FROM catalog_cogs_baseline WHERE code = '101311'").get()).toEqual({ cogs: 10_831_300 });
    expect(sqlite.prepare("SELECT action FROM audit_log WHERE action = 'cogs_from_purchases'").all()).toHaveLength(1);

    // Applying again changes nothing.
    const again = (await (await post({ dryRun: false })).json()) as any;
    expect(again.changed).toEqual([]);
    expect(again.unchanged).toBe(2);
  });

  it("is closed to sales reps (purchase prices are cost data)", async () => {
    const { post, get } = setup("rep");
    expect((await post({})).status).toBe(403);
    expect((await get("/api/accurate/receipts")).status).toBe(403);
  });

  it("reports how far collecting receipts has got", async () => {
    const { sqlite, get } = setup();
    expect(await (await get("/api/accurate/receipts")).json()).toMatchObject({ entity: "PT", inProgress: false, receiptsSeen: 0, lastPassAt: null });
    sqlite.exec("UPDATE accurate_receipt_state SET pass_started_at = '2026-10-15T10:17:46Z', receipts_seen = 60, backfill_since = '15/10/2025'");
    expect(await (await get("/api/accurate/receipts")).json()).toMatchObject({ inProgress: true, receiptsSeen: 60, since: "15/10/2025" });
  });
});
