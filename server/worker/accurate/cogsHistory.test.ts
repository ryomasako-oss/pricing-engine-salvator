import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { D1DatabaseShim } from "../../../scripts/d1-sqlite-shim";
import { accurateRouter } from "../routes/accurate";
import type { Env } from "../env";

interface Body {
  total: number;
  cards: { code: string; pending: unknown; receipts: { receiptNo: string; used: boolean; cost: number | null }[]; changes: { cogs: number }[] }[];
}

function setup(role: string) {
  const sqlite = new DatabaseSync(":memory:");
  const dir = path.resolve(import.meta.dirname, "../../../migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(path.join(dir, f), "utf8"));
  const db = new D1DatabaseShim(sqlite) as unknown as D1Database;
  sqlite.exec(`INSERT INTO users(id, email, name, password_hash, role) VALUES (1, 'u@x', 'U', 'x', '${role}')`);
  sqlite.exec(`INSERT INTO catalog_items(code, name, uom, cogs, list_price, stock) VALUES
    ('101311', 'Keset', 'Pcs', 10657600, 12000000, 0),
    ('A1', 'Kertas 100%', 'Pcs', 9000, 15000, 0),
    ('N1', 'Belum pernah dibeli', 'Pcs', 0, 1000, 0),
    ('H1', 'Lonjakan harga', 'Pcs', 4500, 60000, 0),
    ('C1', 'Map per dus', 'Pcs', 10000, 15000, 0)`);
  sqlite.exec(`INSERT INTO accurate_items(entity, accurate_id, code, name, uom, units, run_id) VALUES
    ('PT', 1, '101311', 'Keset', 'Pcs', '[]', 'r'),
    ('PT', 2, 'A1', 'Kertas 100%', 'Pcs', '[]', 'r'),
    ('PT', 3, 'H1', 'Lonjakan harga', 'Pcs', '[]', 'r'),
    ('PT', 4, 'C1', 'Map per dus', 'Pcs', '[{"uom":"Box","factor":12}]', 'r')`);
  sqlite.exec(`INSERT INTO accurate_receipt_lines(entity, receipt_id, line_id, receipt_no, trans_date, item_code, unit, quantity, unit_price) VALUES
    ('PT', 501, 1, 'RI.2026.05.00021', '2026-05-21', '101311', 'Pcs', 1, 10657600),
    ('PT', 502, 1, 'RI.2026.05.00022', '2026-05-22', '101311', 'Pcs', 1, 11005000),
    ('PT', 503, 1, 'RI.2026.06.00001', '2026-06-02', 'A1', 'Pcs', 1, 9000),
    ('PT', 504, 1, 'RI.2026.10.00044', '2026-10-20', 'H1', 'Pcs', 1, 9800),
    ('PT', 505, 1, 'RI.2026.10.00050', '2026-10-21', 'C1', 'Box', 1, 120000)`);
  // A COGS replacement is recorded by the 0010 trigger.
  sqlite.exec("UPDATE catalog_items SET cogs = 10657600 WHERE code = '101311'");
  sqlite.exec("UPDATE catalog_items SET cogs = 9500 WHERE code = 'A1'");
  sqlite.exec("UPDATE catalog_items SET cogs = 9000 WHERE code = 'A1'");
  const app = new Hono<Env>();
  app.use(async (c, next) => {
    c.set("user", { id: 1, email: "u@x", name: "U", role } as never);
    await next();
  });
  app.route("/api/accurate", accurateRouter);
  const env = { DB: db, ACCURATE_CATALOG_ENTITY: "PT" } as unknown as Env["Bindings"];
  const get = (qs = "") => app.request(`/api/accurate/cogs-history${qs}`, {}, env);
  const json = async (qs = ""): Promise<Body> => (await get(qs)).json() as Promise<Body>;
  return { sqlite, get, json };
}

describe("GET /api/accurate/cogs-history", () => {
  it("is closed to sales, who may not see costs", async () => {
    const { get } = setup("rep");
    expect((await get()).status).toBe(403);
  });

  it("lists items with receipts newest first and earlier COGS values", async () => {
    const { json } = setup("manager");
    const body = await json();
    expect(body.total).toBe(4); // N1 has no COGS and no receipt
    const keset = body.cards.find((c) => c.code === "101311")!;
    expect(keset.receipts.map((r) => r.receiptNo)).toEqual(["RI.2026.05.00022", "RI.2026.05.00021"]);
    expect(keset.pending).toBeNull();
    const a1 = body.cards.find((c) => c.code === "A1")!;
    expect(a1.changes.map((h) => h.cogs)).toEqual([9500, 9000]);
  });

  it("marks the newest receipt whose cost equals the catalog COGS, in the catalog unit", async () => {
    const { json } = setup("manager");
    const { cards } = await json();
    const used = (code: string) => cards.find((c) => c.code === code)!.receipts.filter((r) => r.used).map((r) => r.receiptNo);
    // COGS 10.657.600 came from the older receipt, not the newest one.
    expect(used("101311")).toEqual(["RI.2026.05.00021"]);
    expect(used("A1")).toEqual(["RI.2026.06.00001"]);
    // 120.000 per Box of 12 = 10.000 per Pcs.
    expect(cards.find((c) => c.code === "C1")!.receipts[0]).toMatchObject({ cost: 10000, used: true });
    // COGS 4.500 matches no receipt: nothing is marked.
    expect(used("H1")).toEqual([]);
  });

  it("flags and filters items whose latest receipt differs from the catalog COGS", async () => {
    const { json } = setup("admin");
    const body = await json("?pending=1");
    expect(body.cards.map((c) => c.code)).toEqual(["101311", "H1"]);
    expect(body.cards[0].pending).toMatchObject({ to: 11005000, receiptNo: "RI.2026.05.00022", held: null });
    // A jump apply-cogs holds back is still shown, with the reason.
    expect(body.cards[1].pending).toMatchObject({ to: 9800, held: expect.stringContaining("COGS sekarang") });
  });

  it("searches code and name, treating % and _ as plain text", async () => {
    const { json } = setup("manager");
    expect((await json("?q=keset")).cards.map((c) => c.code)).toEqual(["101311"]);
    expect((await json("?q=100%25")).cards.map((c) => c.code)).toEqual(["A1"]);
    expect((await json("?q=%25")).total).toBe(1);
  });

  it("never writes: catalog COGS is untouched", async () => {
    const { get, sqlite } = setup("manager");
    await get("?pending=1");
    expect(sqlite.prepare("SELECT cogs FROM catalog_items WHERE code = '101311'").get()).toEqual({ cogs: 10657600 });
  });
});
