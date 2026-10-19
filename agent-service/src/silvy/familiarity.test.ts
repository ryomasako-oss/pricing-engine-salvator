import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_ROWS, SUGGEST_SCHEMA, sanitizeSuggestions, silvyFamiliaritySuggest } from "./familiarity.js";
import { authorize, type Llm } from "./handlers.js";
import { GeminiError } from "../gemini.js";

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

const candidates = [
  { item_id: "101", name: "Kertas HVS A4 70gsm Sinar Dunia", category: "Kertas", cogs: 40000, rrp: 55000 },
  { item_id: "202", name: "Pulpen Standard AE7 Hitam" },
];
const body = (over: Record<string, unknown> = {}) => ({
  client_name: "CGV",
  unresolved_rows: [
    { row_id: 1, raw_text: "hvs a4 70 SiDu" },
    { row_id: 2, raw_text: "bolpen std ae7 htm" },
  ],
  catalog_candidates: candidates,
  ...over,
});
const reply = (suggestions: unknown[]) => JSON.stringify({ suggestions });

test("familiarity-suggest asks Gemini once with the response schema and returns one suggestion per row", async () => {
  const llm = fake(
    reply([
      { row_id: 2, suggested_item_id: "202", confidence: 0.82, reasoning: "AE7 hitam = pulpen Standard AE7." },
      { row_id: 1, suggested_item_id: "101", confidence: 0.95, reasoning: "SiDu = Sinar Dunia." },
    ]),
  );
  const out = await silvyFamiliaritySuggest(llm, body());
  assert.equal(out.status, 200);
  assert.deepEqual(out.body.suggestions, [
    { row_id: 1, suggested_item_id: "101", confidence: 0.95, reasoning: "SiDu = Sinar Dunia." },
    { row_id: 2, suggested_item_id: "202", confidence: 0.82, reasoning: "AE7 hitam = pulpen Standard AE7." },
  ]);
  assert.equal(llm.calls.length, 1);
  assert.deepEqual(llm.calls[0].opts.responseSchema, SUGGEST_SCHEMA);
  assert.match(llm.calls[0].messages[0].content, /"raw_text":"hvs a4 70 SiDu"/);
  assert.match(llm.calls[0].messages[0].content, /Klien: "CGV"/);
});

test("familiarity-suggest never sends price or COGS fields to Gemini", async () => {
  const llm = fake(reply([]));
  await silvyFamiliaritySuggest(llm, body());
  const prompt = llm.calls[0].messages[0].content as string;
  assert.doesNotMatch(prompt, /cogs|rrp|40000|55000/i);
  assert.match(prompt, /"category":"Kertas"/);
});

test("an id the model invented is dropped, and skipped or duplicate rows become null", async () => {
  const llm = fake(
    reply([
      { row_id: 1, suggested_item_id: "999", confidence: 0.99, reasoning: "ngarang" },
      { row_id: 1, suggested_item_id: "101", confidence: 0.9, reasoning: "dobel" },
      { row_id: 77, suggested_item_id: "202", confidence: 0.9, reasoning: "baris asing" },
    ]),
  );
  const out = await silvyFamiliaritySuggest(llm, body());
  const s = out.body.suggestions as any[];
  assert.equal(s.length, 2);
  assert.deepEqual(s[0], { row_id: 1, suggested_item_id: null, confidence: 0, reasoning: "Saran Silvy tidak ada di daftar kandidat, dibuang." });
  assert.equal(s[1].row_id, 2);
  assert.equal(s[1].suggested_item_id, null);
  assert.equal(s[1].confidence, 0);
});

test("confidence is clamped to 0..1 and non-numbers become 0", () => {
  const rows = [{ row_id: 1, raw_text: "a" }, { row_id: 2, raw_text: "b" }, { row_id: 3, raw_text: "c" }];
  const s = sanitizeSuggestions(
    [
      { row_id: 1, suggested_item_id: "101", confidence: 7, reasoning: "x" },
      { row_id: 2, suggested_item_id: "101", confidence: -1, reasoning: "x" },
      { row_id: 3, suggested_item_id: "101", confidence: "tinggi", reasoning: "x" },
    ],
    rows,
    candidates,
  );
  assert.deepEqual(s.map((x) => x.confidence), [1, 0, 0]);
});

test("an explicit null suggestion keeps the model's reasoning", () => {
  const s = sanitizeSuggestions([{ row_id: 1, suggested_item_id: null, confidence: 0.1, reasoning: "Tidak ada kandidat tinta." }], [{ row_id: 1, raw_text: "tinta" }], candidates);
  assert.deepEqual(s[0], { row_id: 1, suggested_item_id: null, confidence: 0, reasoning: "Tidak ada kandidat tinta." });
});

test(`more than ${MAX_ROWS} rows is refused, not silently cut`, async () => {
  const llm = fake(reply([]));
  const rows = Array.from({ length: MAX_ROWS + 1 }, (_, i) => ({ row_id: i, raw_text: `r${i}` }));
  const out = await silvyFamiliaritySuggest(llm, body({ unresolved_rows: rows }));
  assert.equal(out.status, 400);
  assert.match(String(out.body.error), /Maksimal 30 baris/);
  assert.equal(llm.calls.length, 0);
  const ok = await silvyFamiliaritySuggest(llm, body({ unresolved_rows: rows.slice(0, MAX_ROWS) }));
  assert.equal(ok.status, 200);
  assert.equal((ok.body.suggestions as any[]).length, MAX_ROWS);
});

test("malformed requests are refused without calling Gemini", async () => {
  const llm = fake(reply([]));
  const bad = [
    null,
    [],
    body({ unresolved_rows: [] }),
    body({ unresolved_rows: [{ row_id: "1", raw_text: "x" }] }),
    body({ unresolved_rows: [{ row_id: 1.5, raw_text: "x" }] }),
    body({ unresolved_rows: [{ row_id: 1, raw_text: "x" }, { row_id: 1, raw_text: "y" }] }),
    body({ catalog_candidates: [] }),
    body({ catalog_candidates: [{ item_id: "", name: "x" }] }),
    body({ catalog_candidates: [{ item_id: "1" }] }),
  ];
  for (const b of bad) assert.equal((await silvyFamiliaritySuggest(llm, b)).status, 400, JSON.stringify(b));
  assert.equal(llm.calls.length, 0);
});

test("Gemini quota and broken JSON become errors, not empty suggestions", async () => {
  assert.equal((await silvyFamiliaritySuggest(fake(new GeminiError("Kuota habis", 429)), body())).status, 429);
  assert.equal((await silvyFamiliaritySuggest(fake(new GeminiError("down", 503)), body())).status, 503);
  const cut = await silvyFamiliaritySuggest(fake('{"suggestions":[{"row_id":1,"sugg'), body());
  assert.equal(cut.status, 502);
});

test("the new route sits behind the shared secret like the other Silvy routes", () => {
  assert.equal(authorize("/silvy/familiarity-suggest", undefined, "s"), "unauthorized");
  assert.equal(authorize("/silvy/familiarity-suggest", "s", ""), "unauthorized");
  assert.equal(authorize("/silvy/familiarity-suggest", "s", "s"), "ok");
});
