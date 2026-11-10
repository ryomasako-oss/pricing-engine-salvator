import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { D1DatabaseShim } from "../../scripts/d1-sqlite-shim";
import { forgetCatalogIndex, recordPicks, searchItems } from "./catalogSearchIndex";

/* The search learns from SI, PI and quotation counts and from picks (migration 0034). */

function setup() {
  forgetCatalogIndex();
  const sqlite = new DatabaseSync(":memory:");
  const dir = path.resolve(import.meta.dirname, "../../migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(path.join(dir, f), "utf8"));
  const add = sqlite.prepare("INSERT INTO catalog_items(code, name, uom, category) VALUES(?, ?, 'Pcs', 'GENERAL')");
  add.run("A", "AAA LAKBAN BENING");
  add.run("B", "BBB LAKBAN BENING");
  add.run("C", "CCC LAKBAN BENING");
  const today = new Date().toISOString().slice(0, 10);
  sqlite.prepare(`INSERT INTO accurate_sales_lines(entity, invoice_id, line_id, trans_date, item_code) VALUES('PT', 1, 1, ?, 'C'), ('PT', 2, 1, ?, 'C')`).run(today, today);
  sqlite.prepare(`INSERT INTO accurate_purchase_lines(entity, receipt_id, line_id, trans_date, item_code) VALUES('PT', 7, 1, ?, 'B')`).run(today);
  const db = new D1DatabaseShim(sqlite) as unknown as D1Database;
  return { db, sqlite };
}

const codes = async (db: D1Database, q: string) => (await searchItems(db, q)).items.map((d) => d.code);

describe("search learning", () => {
  it("ranks by how often an item appears on SI and PI", async () => {
    const { db } = setup();
    expect(await codes(db, "lakban bening")).toEqual(["C", "B", "A"]);
  });

  it("a pick after the same words puts the item first; an old pick fades", async () => {
    const { db, sqlite } = setup();
    await recordPicks(db, "bening lakban", ["A"]);
    expect(await codes(db, "lakban bening")).toEqual(["A", "C", "B"]);
    // A year without being picked again: 1 pick counts ~0.06, still above none, but a fresh pick of B wins.
    sqlite.prepare("UPDATE search_picks SET last_at = datetime('now', '-365 day')").run();
    await recordPicks(db, "lakban bening", ["B"]);
    expect((await codes(db, "lakban bening"))[0]).toBe("B");
  });
});
