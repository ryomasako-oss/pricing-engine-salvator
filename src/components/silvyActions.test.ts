import { describe, expect, it } from "vitest";
import { sanitizeActions } from "../../agent-service/src/silvy/handlers";
import { applyActions } from "./AssistantPanel";
import { DEFAULT_ASSUMPTIONS } from "@shared/engine";
import type { QuoteSnapshot } from "@shared/types";

const snapshot = {
  assumptions: DEFAULT_ASSUMPTIONS,
  items: [{ id: "1", lineNo: 1, code: "A", name: "Kertas A4", uom: "Rim", qty: 100, cogs: 40000, rrp: 60000, role: "CORE" }],
  regions: [],
  meta: {},
  scenario: 0,
} as unknown as QuoteSnapshot;

/* The path an action takes: Gemini proposes it, the agent filters it
   (sanitizeActions), the editor applies it (applyActions). Each side was
   tested alone, with different numbering: the agent kept 0-2, the editor
   took 1-3 (S1-S3), so "pakai S3" never reached the quote. */
describe("Silvy scenario action, agent to editor", () => {
  it.each([1, 2, 3])("S%i proposed by the model is the scenario the editor applies", (n) => {
    const kept = sanitizeActions([{ type: "scenario", value: n }]);
    expect(kept).toEqual([{ type: "scenario", value: n }]);
    const { snapshot: next, labels } = applyActions(kept as never, snapshot);
    expect(next.scenario).toBe(n - 1);
    expect(labels).toEqual([`Skenario jadi S${n}`]);
  });

  it("a number that is no scenario is dropped by the agent", () => {
    expect(sanitizeActions([{ type: "scenario", value: 0 }, { type: "scenario", value: 4 }])).toEqual([]);
  });
});

describe("Silvy per-item margin (Ryoma, 2026-11-04)", () => {
  const two = {
    ...snapshot,
    assumptions: { ...DEFAULT_ASSUMPTIONS, opex: 0, includeLogistics: false, step: 50 },
    items: [
      { id: "1", lineNo: 1, code: "A", name: "Kertas A4", uom: "Rim", qty: 100, cogs: 40000, rrp: 60000, role: "CORE" },
      { id: "2", lineNo: 2, code: "B", name: "Gunting", uom: "Pcs", qty: 1, cogs: 7850, rrp: 10000, role: "CORE" },
      { id: "3", lineNo: 3, code: "C", name: "Tanpa COGS", uom: "Pcs", qty: 1, cogs: 0, rrp: 5000, role: "CORE" },
    ],
  } as unknown as QuoteSnapshot;

  it("prices that line at landed / (1 - margin), rounded up to the step, in the chosen scenario", () => {
    const kept = sanitizeActions([{ type: "item", no: 1, field: "margin", value: 0.3 }]);
    expect(kept).toEqual([{ type: "item", no: 1, field: "margin", value: 0.3 }]);
    const { snapshot: next, labels } = applyActions(kept as never, two);
    // 40.000 / 0,7 = 57.142,86 -> 57.150
    expect(next.items[0].manualPrice).toEqual([57150, null, null]);
    expect(next.items[1].manualPrice).toBeUndefined();
    expect(labels).toEqual(["Kertas A4: margin 30,0%, harga 57.150"]);
  });

  it("never goes above the client's ceiling, and says so", () => {
    const { snapshot: next, labels } = applyActions([{ type: "item", no: 2, field: "margin", value: 30 }] as never, two);
    // 7.850 / 0,7 = 11.214 -> 11.250, capped at 10.000
    expect(next.items[1].manualPrice).toEqual([10000, null, null]);
    expect(labels[0]).toContain("mentok harga maksimal 10.000");
  });

  it("skips a line without COGS, and the agent drops a margin of 95% or more", () => {
    expect(applyActions([{ type: "item", no: 3, field: "margin", value: 0.3 }] as never, two).labels).toEqual([]);
    expect(sanitizeActions([{ type: "item", no: 1, field: "margin", value: 0.95 }, { type: "item", no: 1, field: "margin", value: -0.1 }])).toEqual([]);
  });
});
