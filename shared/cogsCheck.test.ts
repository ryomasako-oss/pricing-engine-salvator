import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cogsProblem } from "./cogsCheck";

describe("cogsProblem", () => {
  it("passes a normal item", () => {
    expect(cogsProblem({ cogs: 1000, list_price: 1500 })).toBeNull();
    expect(cogsProblem({ cogs: 1000, list_price: 0 })).toBeNull(); // no list price: nothing to compare
    expect(cogsProblem({ cogs: 1000, list_price: 1500 }, 900)).toBeNull(); // +11%
    expect(cogsProblem({ cogs: 1000, list_price: 1500 }, null)).toBeNull(); // no reference yet
  });

  it("flags a missing COGS", () => {
    expect(cogsProblem({ cogs: 0, list_price: 1500 })).toBe("COGS kosong di katalog");
    expect(cogsProblem({ cogs: NaN as unknown as number, list_price: 0 })).toBe("COGS kosong di katalog");
  });

  it("flags COGS above the catalog selling price, but not equal to it", () => {
    expect(cogsProblem({ cogs: 2000, list_price: 1500 })).toBe(
      "COGS Rp 2.000 lebih tinggi dari harga jual katalog Rp 1.500",
    );
    expect(cogsProblem({ cogs: 1500, list_price: 1500 })).toBeNull();
  });

  it("flags a move of more than 50% from the reference, either direction; exactly 50% passes", () => {
    expect(cogsProblem({ cogs: 1600, list_price: 0 }, 1000)).toBe(
      "COGS Rp 1.600 berubah 60% dari COGS acuan Rp 1.000; perlu dicek manajer",
    );
    expect(cogsProblem({ cogs: 400, list_price: 0 }, 1000)).toMatch(/berubah 60%/);
    expect(cogsProblem({ cogs: 1500, list_price: 0 }, 1000)).toBeNull();
    expect(cogsProblem({ cogs: 500, list_price: 0 }, 1000)).toBeNull();
  });

  it("checks COGS above list before the jump", () => {
    expect(cogsProblem({ cogs: 2000, list_price: 1500 }, 1000)).toMatch(/lebih tinggi/);
  });
});

describe("reference triggers (migration 0010)", () => {
  // Since 0010 only a manager's confirmation (verify-cogs) moves the reference:
  // no trigger may update catalog_cogs_baseline, in the migration or in the
  // Express copy. A trigger that moved it within COGS_JUMP let small steps
  // carry COGS +106% from its start without a flag.
  it("no trigger updates the reference, in the migration or its Express copy", () => {
    for (const file of ["../migrations/0010_cogs_reference_by_manager.sql", "../server/db.ts"]) {
      const sql = readFileSync(new URL(file, import.meta.url), "utf8");
      const triggers = [...sql.matchAll(/CREATE TRIGGER[\s\S]*?\bEND;/g)].map((m) => m[0]);
      const replaced = triggers.filter((t) => /trg_cogs_(update|insert)/.test(t) && !/IF NOT EXISTS/.test(t));
      expect(replaced.length, file).toBe(2);
      for (const t of replaced) expect(t, file).not.toMatch(/UPDATE\s+catalog_cogs_baseline/i);
    }
  });
});
