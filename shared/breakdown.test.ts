import { describe, expect, it } from "vitest";
import { explainLine, explainQuote } from "./breakdown";
import { DEFAULT_ASSUMPTIONS, DEFAULT_REGIONS, computeEngine } from "./engine";
import type { Assumptions, ItemRole, PricingPolicy, QuoteItem, ScenarioIndex } from "./types";

const POLICY: PricingPolicy = {
  minNetMargin: 0.12,
  minLineMargin: 0.05,
  maxBasketDiscount: 0.2,
  allowBelowCost: false,
  approvalValueThreshold: 100_000_000,
};

const line = (over: Partial<QuoteItem>): QuoteItem => ({
  id: "x",
  lineNo: 1,
  code: "C",
  name: "Item",
  uom: "Pcs",
  qty: 10,
  cogs: 10000,
  rrp: 20000,
  role: "CORE",
  ...over,
});

const explain = (it: QuoteItem, k: ScenarioIndex, a: Assumptions = DEFAULT_ASSUMPTIONS) => {
  const engine = computeEngine(a, [it], DEFAULT_REGIONS);
  return explainLine(engine.rows[0], k, a, engine, POLICY);
};

/** Small deterministic PRNG so a failure is reproducible. */
function rng(seed: number) {
  return () => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed / 2 ** 31;
  };
}

describe("explainLine agrees with the engine", () => {
  it("arrives at the engine's price in every scenario, over 600 random lines", () => {
    const r = rng(42);
    const roles: ItemRole[] = ["LEADER", "CORE", "PROFIT"];
    for (let n = 0; n < 200; n++) {
      const a: Assumptions = {
        ...DEFAULT_ASSUMPTIONS,
        opex: r() * 0.2,
        targetMargin: r() * 0.5,
        leaderMargin: r() * 0.2,
        profitDiscount: r() * 0.2,
        rrpDiscount: r() * 0.3,
        marginFloor: r() * 0.15,
        step: [1, 50, 100, 500][Math.floor(r() * 4)],
        includeLogistics: r() > 0.5,
      };
      const cogs = Math.round(500 + r() * 200000);
      const items = [0, 1, 2].map((i) =>
        line({
          id: `l${i}`,
          lineNo: i + 1,
          cogs,
          rrp: Math.round(cogs * (0.8 + r() * 1.2)),
          qty: 1 + Math.floor(r() * 100),
          role: roles[Math.floor(r() * 3)],
          manualPrice: r() > 0.85 ? [Math.round(cogs * 1.3), null, null] : undefined,
        }),
      );
      const engine = computeEngine(a, items, DEFAULT_REGIONS);
      for (const row of engine.rows) {
        for (const k of [0, 1, 2] as ScenarioIndex[]) {
          const ex = explainLine(row, k, a, engine, POLICY);
          expect(ex.price).toBe(row.prices[k]);
          if (!row.overridden[k]) expect(ex.computed, `line ${row.lineNo} S${k + 1} ${JSON.stringify(a)}`).toBe(row.prices[k]);
        }
      }
    }
  });
});

describe("explainLine wording", () => {
  it("S1 below the ceiling: landed, target, rounded price", () => {
    const ex = explain(line({}), 0);
    // landed 10.800, target 14.400 at 25%, already a multiple of 50.
    expect(ex.steps[0]).toContain("landed cost Rp 10.800");
    expect(ex.steps[1]).toContain("= Rp 14.400");
    expect(ex.steps[2]).toContain("di bawah plafon RRP Rp 20.000");
    expect(ex.price).toBe(14400);
    expect(ex.flags).toEqual([]);
  });

  it("S1 capped at RRP says so", () => {
    const ex = explain(line({ rrp: 12000 }), 0);
    expect(ex.steps.join(" ")).toContain("melebihi plafon RRP Rp 12.000");
    expect(ex.price).toBe(12000);
  });

  it("S3 floor hit says the discount was held back", () => {
    const ex = explain(line({ rrp: 11500 }), 2);
    expect(ex.steps.join(" ")).toContain("menembus margin minimum");
    expect(ex.price).toBeGreaterThan(Math.floor(11500 * 0.9));
  });

  // Regression: with the floor above the ceiling the text said "held at Rp 52.000"
  // right after naming a Rp 53.450 floor, as if 52.000 were the floor.
  it("S3 floor above the RRP ceiling says the price stops at RRP, below the minimum margin", () => {
    const e = explain(line({ cogs: 47000, rrp: 52000 }), 2);
    expect(e.price).toBe(52000);
    expect(e.steps.join(" ")).toMatch(/di atas plafon RRP Rp 52\.000, jadi harga berhenti di RRP dan marginnya di bawah minimum/);
    expect(e.steps.join(" ")).not.toMatch(/ditahan di Rp 52\.000/);
  });

  it("S2 leader and profit roles are named", () => {
    expect(explain(line({ role: "LEADER" }), 1).steps.join(" ")).toContain("Item LEADER");
    expect(explain(line({ role: "PROFIT" }), 1).steps.join(" ")).toContain("Item PROFIT");
    expect(explain(line({ role: "CORE" }), 1).steps.join(" ")).toContain("Item CORE");
  });

  it("a manual price is called out, with the automatic price for comparison", () => {
    const ex = explain(line({ manualPrice: [16000, null, null] }), 0);
    expect(ex.steps.join(" ")).toContain("Harga diisi manual Rp 16.000 (hitungan otomatis Rp 14.400)");
    expect(ex.price).toBe(16000);
  });

  it("flags below cost, thin margin and missing COGS", () => {
    expect(explain(line({ rrp: 9000 }), 0).flags).toContain("Di bawah modal");
    expect(explain(line({ rrp: 11000 }), 0).flags).toContain("Margin di bawah minimum 5,0%");
    expect(explain(line({ cogs: 0, estCogs: true }), 0).flags).toContain("COGS belum pasti");
  });
});

describe("explainQuote", () => {
  it("summarises the chosen scenario and reports policy breaches", () => {
    // Line 2 is capped at RRP but still above cost; line 3 is below cost
    // (the engine reports BELOW COST ahead of CAPPED, so it isn't "capped").
    const items = [line({ lineNo: 1 }), line({ lineNo: 2, rrp: 12000 }), line({ lineNo: 3, rrp: 9000 })];
    const engine = computeEngine(DEFAULT_ASSUMPTIONS, items, DEFAULT_REGIONS);
    const b = explainQuote(engine, 0, DEFAULT_ASSUMPTIONS, POLICY, [
      { code: "BELOW_COST", severity: "block", message: "1 item di bawah modal" },
    ]);
    expect(b.headline).toMatch(/^S1 Full Margin: nilai Rp /);
    expect(b.lines).toHaveLength(3);
    expect(b.points.join(" ")).toContain("1 item dijual di bawah modal");
    expect(b.points.join(" ")).toContain("1 item mentok di plafon RRP");
    expect(b.points.join(" ")).toContain("DIBLOKIR — 1 item di bawah modal");
  });

  it("S2 with only CORE items says there is no cross-subsidy, instead of Rp 0 figures", () => {
    const engine = computeEngine(DEFAULT_ASSUMPTIONS, [line({})], DEFAULT_REGIONS);
    const text = explainQuote(engine, 1, DEFAULT_ASSUMPTIONS, POLICY, []).points.join(" ");
    expect(text).toContain("Semua item berperan CORE");
    expect(text).not.toContain("Subsidi:");
    const mixed = computeEngine(DEFAULT_ASSUMPTIONS, [line({ role: "LEADER" }), line({ lineNo: 2, role: "PROFIT" })], DEFAULT_REGIONS);
    expect(explainQuote(mixed, 1, DEFAULT_ASSUMPTIONS, POLICY, []).points.join(" ")).toContain("Subsidi: item LEADER memberi");
  });

  it("says all limits are met when there are no breaches", () => {
    const engine = computeEngine(DEFAULT_ASSUMPTIONS, [line({})], DEFAULT_REGIONS);
    expect(explainQuote(engine, 1, DEFAULT_ASSUMPTIONS, POLICY, []).points.join(" ")).toContain("semua batas terpenuhi");
  });
});
