import { test } from "node:test";
import assert from "node:assert/strict";
import { GeminiClient, GeminiError, cleanApiKey, describeGeminiHttp, extractJSON, DEFAULT_GEMINI_MODEL } from "./gemini.js";

test("cleanApiKey strips quotes, CR and trailing comments", () => {
  assert.equal(cleanApiKey('"AQ.abc123" # kunci'), "AQ.abc123");
  assert.equal(cleanApiKey("AQ.abc123\r"), "AQ.abc123");
  assert.equal(cleanApiKey(undefined), "");
});

test("client refuses an empty key and defaults the model", () => {
  assert.throws(() => new GeminiClient("  "), /GEMINI_API_KEY/);
  assert.equal(new GeminiClient("k").model, DEFAULT_GEMINI_MODEL);
  assert.equal(new GeminiClient("k", "gemini-3.5-flash").model, "gemini-3.5-flash");
});

test("http errors become messages a salesperson can act on", () => {
  assert.match(describeGeminiHttp(400, "API key not valid"), /Kunci Gemini ditolak/);
  assert.match(describeGeminiHttp(403, ""), /billing/);
  assert.match(describeGeminiHttp(404, ""), /GEMINI_MODEL/);
  assert.match(describeGeminiHttp(429, ""), /batas pemakaian/);
});

test("extractJSON handles fences, prose and garbage", () => {
  assert.deepEqual(extractJSON('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJSON('Ini hasilnya: {"a":2} selesai'), { a: 2 });
  assert.equal(extractJSON("bukan json"), null);
});

function withFetch(impl: typeof fetch, run: () => Promise<void>) {
  const orig = globalThis.fetch;
  globalThis.fetch = impl;
  return run().finally(() => {
    globalThis.fetch = orig;
  });
}

test("chat sends the key in a header, never in the URL, and joins non-thought parts", async () => {
  let seenUrl = "";
  let seenKey = "";
  let seenBody: any;
  await withFetch(
    (async (url: any, init: any) => {
      seenUrl = String(url);
      seenKey = init.headers["x-goog-api-key"];
      seenBody = JSON.parse(init.body);
      return new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ text: "rahasia", thought: true }, { text: " Halo " }, { text: "dunia" }] } }] }),
        { status: 200 },
      );
    }) as typeof fetch,
    async () => {
      const out = await new GeminiClient("SECRETKEY").chat("sys", [{ role: "user", content: "hi" }], { json: true });
      assert.equal(out, "Halo dunia");
    },
  );
  assert.ok(!seenUrl.includes("SECRETKEY"));
  assert.equal(seenKey, "SECRETKEY");
  assert.equal(seenBody.systemInstruction.parts[0].text, "sys");
  assert.equal(seenBody.generationConfig.responseMimeType, "application/json");
});

test("chat maps HTTP and network failures to GeminiError", async () => {
  await withFetch((async () => new Response("{}", { status: 429 })) as typeof fetch, async () => {
    await assert.rejects(new GeminiClient("k").chat("s", []), (e: any) => e instanceof GeminiError && e.status === 429);
  });
  await withFetch((async () => { throw new Error("down"); }) as typeof fetch, async () => {
    await assert.rejects(new GeminiClient("k").chat("s", []), (e: any) => e instanceof GeminiError && e.status === 503);
  });
  await withFetch((async () => new Response(JSON.stringify({ promptFeedback: { blockReason: "SAFETY" } }), { status: 200 })) as typeof fetch, async () => {
    await assert.rejects(new GeminiClient("k").chat("s", []), /SAFETY/);
  });
});
