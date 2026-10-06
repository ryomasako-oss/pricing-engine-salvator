import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COGS_JUMP, cogsProblem } from "./cogsCheck";

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

describe("COGS_JUMP and the reference triggers", () => {
  // The triggers move the reference only within the same limit the check
  // flags at; if the two disagree, an item can be flagged while its
  // reference silently moves on (or the other way round).
  it("uses the same limit as the triggers in migration 0009 and its Express copy", () => {
    for (const file of ["../migrations/0009_cogs_sanity.sql", "../server/db.ts"]) {
      const sql = readFileSync(new URL(file, import.meta.url), "utf8");
      const limits = [...sql.matchAll(/<=\s*([\d.]+)\s*\*\s*cogs/g)].map((m) => Number(m[1]));
      expect(limits, file).toEqual([COGS_JUMP, COGS_JUMP]);
    }
  });
});
