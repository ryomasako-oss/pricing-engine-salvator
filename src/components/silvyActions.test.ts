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
