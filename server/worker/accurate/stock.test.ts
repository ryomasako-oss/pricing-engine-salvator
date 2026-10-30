import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { D1DatabaseShim } from "../../../scripts/d1-sqlite-shim";
import { refreshStock, STOCK_AS_OF_KEY } from "./stock";

function freshDb() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = path.resolve(import.meta.dirname, "../../../migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(path.join(dir, f), "utf8"));
  return { sqlite, db: new D1DatabaseShim(sqlite) as unknown as D1Database };
}

describe("catalog stock follows Accurate after every completed run", () => {
  it("copies the entity's total across warehouses, skips other units, suspended and non-Accurate items", async () => {
    const { sqlite, db } = freshDb();
    sqlite.exec(`INSERT INTO catalog_items(code, name, uom, cogs, list_price, stock) VALUES
      ('A', 'Dua gudang', 'Pcs', 900, 1000, 3),
      ('abc-01', 'Beda huruf', 'PCS', 0, 1000, 1),
      ('B', 'Satuan beda', 'Pcs', 900, 1000, 4),
      ('C', 'Habis', 'Pcs', 0, 1000, 9),
      ('S', 'Suspend', 'Pcs', 0, 1000, 5),
      ('M', 'Manual', 'Pcs', 0, 1000, 6)`);
    sqlite.exec(`INSERT INTO accurate_items(entity, accurate_id, code, name, uom, unit_price, units, category, suspended, run_id) VALUES
      ('PT', 1, 'A', 'A', 'Pcs', 1000, '[]', '', 0, 'r1'),
      ('PT', 2, 'ABC-01', 'X', 'pcs', 1000, '[]', '', 0, 'r1'),
      ('PT', 3, 'B', 'B', 'Box', 1000, '[]', '', 0, 'r1'),
      ('PT', 4, 'C', 'C', '', 1000, '[]', '', 0, 'r1'),
      ('PT', 5, 'S', 'S', 'Pcs', 1000, '[]', '', 1, 'r1'),
      ('CV', 6, 'M', 'M', 'Pcs', 1000, '[]', '', 0, 'r1')`);
    sqlite.exec(`INSERT INTO accurate_stock(entity, warehouse_id, item_code, quantity, run_id) VALUES
      ('PT', 1, 'A', 7, 'r1'), ('PT', 2, 'A', -2, 'r1'), ('CV', 1, 'A', 100, 'r1'),
      ('PT', 1, 'ABC-01', 11, 'r1'), ('PT', 1, 'B', 50, 'r1'), ('PT', 1, 'S', 50, 'r1'), ('CV', 1, 'M', 50, 'r1')`);
    sqlite.exec(`INSERT INTO accurate_sync_state(entity, phase, last_success_at) VALUES ('PT', 'idle', '2026-10-30T01:00:00.000Z')`);

    expect(await refreshStock(db, "PT")).toBe(3);
    expect(sqlite.prepare("SELECT code, stock FROM catalog_items ORDER BY code").all()).toEqual([
      { code: "A", stock: 5 }, // 7 + (-2), PT only
      { code: "B", stock: 4 }, // Accurate counts in Box, catalog in Pcs
      { code: "C", stock: 0 }, // no stock rows left: sold out
      { code: "M", stock: 6 }, // only in CV
      { code: "S", stock: 5 }, // suspended
      { code: "abc-01", stock: 11 }, // same code, other case
    ]);
    expect(sqlite.prepare("SELECT value FROM settings WHERE key = ?").get(STOCK_AS_OF_KEY)).toEqual({ value: "2026-10-30T01:00:00.000Z" });

    // Nothing changed since: no rows rewritten.
    expect(await refreshStock(db, "PT")).toBe(0);
  });
});
