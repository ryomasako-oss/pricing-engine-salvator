import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { D1DatabaseShim } from "../../../scripts/d1-sqlite-shim";
import { addNewItems } from "./newItems";
import { syncTick } from "./sync";
import { countQueries } from "./testing";
import { cogsProblem } from "../../../shared/cogsCheck";

function freshDb() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = path.resolve(import.meta.dirname, "../../../migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(path.join(dir, f), "utf8"));
  return { sqlite, db: new D1DatabaseShim(sqlite) as unknown as D1Database };
}

/**
 * Catalog has OLD (Pcs, COGS 900). Accurate PT has OLD with other values, NEW1 (Box of 12, stock in
 * two warehouses), NEW2 (no price), SUSP (suspended) and an uncoded row; CV has CVONLY.
 */
function seed(sqlite: DatabaseSync, lastSuccess = new Date().toISOString()) {
  sqlite.exec(`INSERT INTO catalog_items(code, name, uom, cogs, list_price, stock) VALUES ('OLD', 'Lama', 'Pcs', 900, 1000, 3)`);
  sqlite.exec(`INSERT INTO accurate_items(entity, accurate_id, code, name, uom, unit_price, units, category, suspended, run_id) VALUES
    ('PT', 1, 'OLD', 'Lama diganti', 'Box', 99999, '[]', 'ATK', 0, 'r1'),
    ('PT', 2, 'NEW1', 'JOYKO MECHANICAL PENCIL MP-52', 'PCS', 2500, '[{"uom":"Lusin","factor":12}]', 'ATK', 0, 'r1'),
    ('PT', 3, 'NEW2', 'Tanpa harga', '', 0, '[]', '', 0, 'r1'),
    ('PT', 4, 'SUSP', 'Disuspend', 'Pcs', 100, '[]', '', 1, 'r1'),
    ('PT', 5, '', 'Tanpa kode', 'Pcs', 100, '[]', '', 0, 'r1'),
    ('CV', 6, 'CVONLY', 'Hanya CV', 'Pcs', 100, '[]', '', 0, 'r1')`);
  sqlite.exec(`INSERT INTO accurate_stock(entity, warehouse_id, item_code, quantity, run_id) VALUES
    ('PT', 1, 'NEW1', 7, 'r1'), ('PT', 2, 'NEW1', 5, 'r1'), ('PT', 1, 'OLD', 40, 'r1'), ('CV', 1, 'NEW1', 100, 'r1')`);
  sqlite.exec(`INSERT OR REPLACE INTO accurate_sync_state(entity, phase, last_success_at) VALUES ('PT', 'idle', '${lastSuccess}')`);
}

const catalog = (sqlite: DatabaseSync) =>
  sqlite.prepare("SELECT code, name, uom, cogs, list_price, stock, category, source FROM catalog_items ORDER BY code").all();

describe("items new in Accurate join the catalog on their own", () => {
  it("adds only the entity's active, coded items the catalog lacks, with COGS 0 and that entity's stock", async () => {
    const { sqlite, db } = freshDb();
    seed(sqlite);
    const r = await addNewItems(db, "PT");
    expect(r).toEqual({ added: 2, codes: ["NEW1", "NEW2"] });
    expect(catalog(sqlite)).toEqual([
      { code: "NEW1", name: "JOYKO MECHANICAL PENCIL MP-52", uom: "PCS", cogs: 0, list_price: 2500, stock: 12, category: "ATK", source: "accurate:PT" },
      { code: "NEW2", name: "Tanpa harga", uom: "Pcs", cogs: 0, list_price: 0, stock: 0, category: "", source: "accurate:PT" },
      // An existing item is left exactly as it was: name, unit, price and stock change only through "Terapkan".
      { code: "OLD", name: "Lama", uom: "Pcs", cogs: 900, list_price: 1000, stock: 3, category: "", source: "" },
    ]);
    expect(sqlite.prepare("SELECT code, uom, factor FROM catalog_item_uoms").all()).toEqual([{ code: "NEW1", uom: "Lusin", factor: 12 }]);
    const a = sqlite.prepare("SELECT actor_id, action, detail FROM audit_log WHERE action = 'accurate_new_items'").all() as { actor_id: null; detail: string }[];
    expect(a).toHaveLength(1);
    expect(a[0].actor_id).toBeNull();
    expect(JSON.parse(a[0].detail)).toEqual({ entity: "PT", added: 2, codes: ["NEW1", "NEW2"] });
  });

  it("an Accurate code that differs from a catalog code only in case is not added again", async () => {
    const { sqlite, db } = freshDb();
    sqlite.exec(`INSERT INTO catalog_items(code, name, uom, cogs, list_price, stock) VALUES ('ABC-01', 'Map', 'Pcs', 900, 1000, 3)`);
    sqlite.exec(`INSERT INTO accurate_items(entity, accurate_id, code, name, uom, unit_price, units, category, suspended, run_id) VALUES
      ('PT', 1, 'abc-01', 'Map kecil', 'Pcs', 1000, '[]', '', 0, 'r1'),
      ('PT', 2, 'NEW1', 'Baru', 'Pcs', 500, '[]', '', 0, 'r1')`);
    expect(await addNewItems(db, "PT")).toEqual({ added: 1, codes: ["NEW1"] });
    expect(sqlite.prepare("SELECT code FROM catalog_items ORDER BY code").all()).toEqual([{ code: "ABC-01" }, { code: "NEW1" }]);
  });

  it("a new item is held on quotes until it has a COGS", async () => {
    const { sqlite, db } = freshDb();
    seed(sqlite);
    await addNewItems(db, "PT");
    const row = sqlite.prepare("SELECT cogs, list_price FROM catalog_items WHERE code = 'NEW1'").get() as { cogs: number; list_price: number };
    expect(cogsProblem(row)).toBe("COGS kosong di katalog");
  });

  it("repeating adds nothing and writes no audit entry", async () => {
    const { sqlite, db } = freshDb();
    seed(sqlite);
    await addNewItems(db, "PT");
    expect(await addNewItems(db, "PT")).toEqual({ added: 0, codes: [] });
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'accurate_new_items'").get()).toEqual({ n: 1 });
  });

  it("links a waiting \"Barang baru\" request whose code arrived", async () => {
    const { sqlite, db } = freshDb();
    seed(sqlite);
    sqlite.exec(`INSERT INTO users(id, email, name, password_hash, role) VALUES (9, 'x@x', 'X', 'h', 'rep')`);
    sqlite.exec(`INSERT INTO pending_items(code, name, uom, status, requested_by) VALUES ('NEW1', 'Pensil', 'Pcs', 'submitted', 9)`);
    await addNewItems(db, "PT");
    expect(sqlite.prepare("SELECT status FROM pending_items").get()).toEqual({ status: "linked" });
  });

  it("the cron adds them once per completed run, before the cross-check, within the budget", async () => {
    const { sqlite, db: raw } = freshDb();
    seed(sqlite);
    const { db, queries, reset } = countQueries(raw);
    const env = { DB: db, ACCURATE_TOKEN_PT: "aat.t", ACCURATE_SIGNATURE_SECRET: "s" } as never;
    await syncTick(env, { deadlineMs: 5_000 });
    expect((catalog(sqlite) as { code: string }[]).map((r) => r.code)).toEqual(["NEW1", "NEW2", "OLD"]);
    expect(queries()).toBeLessThanOrEqual(50);
    // The next tick has no new run: nothing is added again.
    sqlite.exec("DELETE FROM catalog_items WHERE code = 'NEW2'");
    reset();
    await syncTick(env, { deadlineMs: 5_000 });
    expect((catalog(sqlite) as { code: string }[]).map((r) => r.code)).toEqual(["NEW1", "OLD"]);
  });

  it("ACCURATE_AUTO_NEW_ITEMS = \"false\" turns it off and leaves the cross-check running", async () => {
    const { sqlite, db } = freshDb();
    seed(sqlite);
    sqlite.exec(`INSERT INTO catalog_items(code, name, uom, cogs, list_price, stock) VALUES ('NEW1', 'Pensil', 'Pcs', 0, 2500, 1)`);
    await syncTick({ DB: db, ACCURATE_AUTO_NEW_ITEMS: "false", ACCURATE_TOKEN_PT: "aat.t", ACCURATE_SIGNATURE_SECRET: "s" } as never, { deadlineMs: 5_000 });
    expect(catalog(sqlite)).toHaveLength(2);
    // Stock of items already in the catalog is still refreshed (stock.ts): 7 + 5 in PT's warehouses.
    expect(sqlite.prepare("SELECT stock FROM catalog_items WHERE code = 'NEW1'").get()).toEqual({ stock: 12 });
    // The cross-check still ran.
    expect(sqlite.prepare("SELECT reconciled_at IS NOT NULL AS ok FROM accurate_sync_state WHERE entity = 'PT'").get()).toEqual({ ok: 1 });
  });
});
