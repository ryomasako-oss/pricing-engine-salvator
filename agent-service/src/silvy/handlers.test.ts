import { test } from "node:test";
import assert from "node:assert/strict";
import { authorize, sanitizeActions, secretMatches, silvyAsk, silvyDocument, type Llm } from "./handlers.js";
import { GeminiError } from "../gemini.js";
import { DEFAULT_ASSUMPTIONS } from "../../../shared/engine.js";
import { DEFAULT_POLICY } from "../../../shared/policy.js";

const body = (over: Record<string, unknown> = {}) => ({
  context: {
    snapshot: {
      assumptions: DEFAULT_ASSUMPTIONS,
      items: [{ id: "1", lineNo: 1, code: "A", name: "Kertas A4", uom: "Rim", qty: 100, cogs: 40000, rrp: 60000, role: "CORE" }],
      regions: [],
      meta: {},
      scenario: 0,
    },
    number: "Q-1", title: "Uji", status: "draft", clientName: "PT Uji", sections: {}, notes: [],
  },
  policy: DEFAULT_POLICY,
  messages: [{ role: "user", content: "halo" }],
  ...over,
});

const fake = (reply: string | Error): Llm & { calls: any[] } => {
  const calls: any[] = [];
  return {
    calls,
    async chat(system, messages, opts) {
      calls.push({ system, messages, opts });
      if (reply instanceof Error) throw reply;
      return reply;
    },
  };
};

test("secretMatches is strict and fail-closed", () => {
  assert.ok(secretMatches("abc", "abc"));
  assert.ok(!secretMatches("abd", "abc"));
  assert.ok(!secretMatches("", "abc"));
  assert.ok(!secretMatches(undefined, "abc"));
  assert.ok(!secretMatches("abc", ""));
});

test("sanitizeActions keeps known shapes and drops everything else", () => {
  const out = sanitizeActions([
    { type: "set", key: "targetMargin", value: 0.18 },
    { type: "set", key: "targetMargin", value: 18 }, // bukan pecahan
    { type: "set", key: "months", value: 12 },
    { type: "set", key: "months", value: 1.5 },
    { type: "set", key: "password", value: 1 },
    { type: "set", key: "includeLogistics", value: true },
    { type: "item", no: 3, field: "qty", value: 50 },
    { type: "item", no: 3, field: "qty", value: -1 },
    { type: "item", no: 3, field: "role", value: "LEADER" },
    { type: "item", no: 3, field: "role", value: "BOSS" },
    { type: "item", no: 3, field: "code", value: "X" },
    { type: "scenario", value: 2 },
    { type: "scenario", value: 5 },
    "string", null, { type: "exec", cmd: "rm" },
  ]);
  assert.deepEqual(out, [
    { type: "set", key: "targetMargin", value: 0.18 },
    { type: "set", key: "months", value: 12 },
    { type: "set", key: "includeLogistics", value: true },
    { type: "item", no: 3, field: "qty", value: 50 },
    { type: "item", no: 3, field: "role", value: "LEADER" },
    { type: "scenario", value: 2 },
  ]);
  assert.deepEqual(sanitizeActions("nope"), []);
});

test("ask: grounds the prompt, maps roles, forces JSON, returns the shaped answer", async () => {
  const llm = fake('{"answer":"ok","sources":["summary",7],"actions":[{"type":"scenario","value":1},{"type":"x"}],"followups":["a","b","c","d"]}');
  const r = await silvyAsk(llm, body({ messages: [{ role: "user", content: "q1" }, { role: "assistant", content: "a1" }, { role: "user", content: "q2" }] }));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { answer: "ok", sources: ["summary"], actions: [{ type: "scenario", value: 1 }], followups: ["a", "b", "c"] });
  assert.match(llm.calls[0].system, /DATA QUOTATION:/);
  assert.deepEqual(llm.calls[0].messages.map((m: any) => m.role), ["user", "model", "user"]);
  assert.equal(llm.calls[0].opts.json, true);
});

test("ask: prose instead of JSON falls back to the raw text with no actions", async () => {
  const r = await silvyAsk(fake("Jawaban biasa"), body());
  assert.equal(r.status, 200);
  assert.equal(r.body.answer, "Jawaban biasa");
  assert.deepEqual(r.body.actions, []);
});

test("ask: rejects malformed requests without calling the model", async () => {
  const llm = fake("{}");
  const bad: unknown[] = [
    null,
    body({ messages: [] }),
    body({ messages: [{ role: "user", content: "x".repeat(8001) }] }),
    body({ messages: [{ role: "system", content: "x" }] }),
    body({ messages: [{ role: "assistant", content: "x" }] }),
    body({ policy: undefined }),
    body({ context: { snapshot: { assumptions: {}, items: "x", regions: [] } } }),
    { ...body(), context: { ...body().context, snapshot: { ...body().context.snapshot, scenario: 9 } } },
  ];
  for (const b of bad) assert.equal((await silvyAsk(llm, b)).status, 400, JSON.stringify(b)?.slice(0, 60));
  assert.equal(llm.calls.length, 0);
});

test("ask: a quote the engine can't compute is a 400, not a crash", async () => {
  const b = body();
  (b.context.snapshot as any).items = [null];
  assert.equal((await silvyAsk(fake("{}"), b)).status, 400);
});

test("ask: Gemini failures keep their user-facing message and a sane status", async () => {
  const r429 = await silvyAsk(fake(new GeminiError("batas", 429)), body());
  assert.equal(r429.status, 429);
  const r500 = await silvyAsk(fake(new GeminiError("rusak", 500)), body());
  assert.equal(r500.status, 502);
  const rx = await silvyAsk(fake(new Error("boom")), body());
  assert.equal(rx.status, 500);
  assert.doesNotMatch(String(rx.body.error), /boom/);
});

test("document: known kinds work, unknown kinds (incl. prototype keys) are refused", async () => {
  const llm = fake("## Briefing");
  const ok = await silvyDocument(llm, body({ kind: "briefing" }));
  assert.deepEqual(ok, { status: 200, body: { content: "## Briefing" } });
  assert.match(llm.calls[0].messages[0].content, /briefing untuk atasan/);
  for (const kind of ["nope", "__proto__", "constructor", 5, undefined])
    assert.equal((await silvyDocument(llm, body({ kind }))).status, 400);
  assert.equal(llm.calls.length, 1);
});

test("authorize: /health is always open", () => {
  assert.equal(authorize("/health", undefined, ""), "ok");
  assert.equal(authorize("/health", undefined, "s"), "ok");
});

test("authorize: with a secret set, every other route needs it (no open /sync, /recommend, /status)", () => {
  for (const path of ["/status", "/sync", "/recommend", "/quotes/similar", "/silvy/ask", "/webhook/gmail", "/nope"]) {
    assert.equal(authorize(path, undefined, "s"), "unauthorized", path);
    assert.equal(authorize(path, "wrong", "s"), "unauthorized", path);
    assert.equal(authorize(path, "s", "s"), "ok", path);
  }
});

test("authorize: without a secret only local-style routes stay open and /silvy/* is closed", () => {
  assert.equal(authorize("/status", undefined, ""), "ok");
  assert.equal(authorize("/silvy/ask", undefined, ""), "unauthorized");
  assert.equal(authorize("/silvy/document", "anything", ""), "unauthorized");
});
