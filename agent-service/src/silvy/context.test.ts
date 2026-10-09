import { test } from "node:test";
import assert from "node:assert/strict";
import { buildContext, chatSystem, docSystem, DOCS, RULES_TEXT } from "./context.js";
import { DEFAULT_ASSUMPTIONS } from "../../../shared/engine.js";
import { DEFAULT_POLICY } from "../../../shared/policy.js";
import type { QuoteSnapshot, QuoteItem, ScenarioIndex } from "../../../shared/types.js";

const item = (over: Partial<QuoteItem> = {}): QuoteItem => ({
  id: "x", lineNo: 1, code: "T1", name: "Kertas A4", uom: "Rim", qty: 100, cogs: 40000, rrp: 60000, role: "CORE", ...over,
});

const quote = (items: QuoteItem[] = [item()]): QuoteSnapshot & { scenario: ScenarioIndex; number: string; title: string; status: string } => ({
  assumptions: DEFAULT_ASSUMPTIONS, items, regions: [], meta: {} as QuoteSnapshot["meta"], scenario: 0,
  number: "Q-001", title: "Kontrak ATK", status: "draft",
});

const build = (sections: Record<string, boolean>, items?: QuoteItem[], notes: { id: string; title: string; text: string }[] = []) =>
  buildContext({ quote: quote(items), policy: DEFAULT_POLICY, clientName: "PT Contoh", notes, sections });

test("summary and policy are always present; optional sections are opt-in", () => {
  const base = build({});
  assert.match(base, /\[summary\]/);
  assert.match(base, /\[policy\]/);
  assert.match(base, /Q-001 "Kontrak ATK"/);
  assert.match(base, /PT Contoh/);
  assert.doesNotMatch(base, /\[items\]|\[assumptions\]|\[delivery\]/);
  const full = build({ items: true, assumptions: true, delivery: true });
  assert.match(full, /\[items\]/);
  assert.match(full, /Kertas A4/);
  assert.match(full, /\[assumptions\]/);
  assert.match(full, /\[delivery\]/);
});

test("items are capped at 200 rows with an explicit overflow note", () => {
  const many = Array.from({ length: 205 }, (_, i) => item({ id: `i${i}`, lineNo: i + 1, name: `Barang ${i + 1}` }));
  const ctx = build({ items: true }, many);
  assert.match(ctx, /\(5 item lain tidak ditampilkan\)/);
  assert.doesNotMatch(ctx, /Barang 205\|/);
});

test("notes are included only when their id is switched on, and truncated", () => {
  const notes = [{ id: "n1", title: "Catatan", text: "x".repeat(7000) }];
  assert.doesNotMatch(build({}, undefined, notes), /\[n1\]/);
  const on = build({ n1: true }, undefined, notes);
  assert.match(on, /\[n1\] Catatan/);
  assert.ok(on.length < 7000 + 3000);
});

test("prompts carry the engine rules, the grounding rule and the data", () => {
  const ctx = build({});
  for (const sys of [chatSystem(ctx), docSystem(ctx)]) {
    assert.ok(sys.includes(RULES_TEXT));
    assert.ok(sys.includes("DATA QUOTATION:\n" + ctx));
    assert.match(sys, /Silvy/);
    assert.doesNotMatch(sys, /Claude/);
  }
  assert.match(chatSystem(ctx), /HANYA dari DATA QUOTATION/);
});

test("all four documents are defined", () => {
  assert.deepEqual(Object.keys(DOCS).sort(), ["briefing", "faq", "negotiation", "risk"]);
});
