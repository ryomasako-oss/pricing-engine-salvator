import { describe, expect, it } from "vitest";
import { handleChat, pickClient } from "./chat.js";

const reply = (obj: unknown) => ({ candidates: [{ content: { parts: [{ text: typeof obj === "string" ? obj : JSON.stringify(obj) }] } }] });
function fakeFetch(body: unknown, status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { fn, calls };
}
const user = (content: string) => ({ role: "user" as const, content });

describe("handleChat", () => {
  it("is off (503) without a key and never calls out", async () => {
    const f = fakeFetch({});
    expect((await handleChat({ messages: [user("halo")] }, { fetchFn: f.fn })).status).toBe(503);
    expect(f.calls).toHaveLength(0);
  });

  it("refuses malformed input, an empty history, and a history that ends on the assistant", async () => {
    const deps = { apiKey: "k", fetchFn: fakeFetch({}).fn };
    expect((await handleChat(null, deps)).status).toBe(400);
    expect((await handleChat({ messages: [] }, deps)).status).toBe(400);
    expect((await handleChat({ messages: [{ role: "assistant", content: "hi" }] }, deps)).status).toBe(400);
    expect((await handleChat({ messages: Array.from({ length: 21 }, () => user("x")) }, deps)).status).toBe(400);
    expect((await handleChat({ messages: [user("x".repeat(4001))] }, deps)).status).toBe(400);
  });

  it("returns the reply, request rows and the client it was told about", async () => {
    const f = fakeFetch(reply({ reply: "Siap, 2 item. Tekan Tinjau.", client: "pt bahtera adi jaya.", lines: [{ name: "Pulpen", qty: 10, uom: "lusin" }, { name: "Kertas A4" }] }));
    const r = await handleChat({ messages: [user("untuk PT Bahtera: pulpen 10 lusin, kertas A4")], clients: ["BAHTERA ADI JAYA PT", "Maju Jaya"] }, { apiKey: "k", fetchFn: f.fn });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({
      reply: "Siap, 2 item. Tekan Tinjau.",
      client: "BAHTERA ADI JAYA PT",
      lines: [{ name: "Pulpen", qty: 10, uom: "lusin" }, { name: "Kertas A4", qty: 1, noQty: true }],
    });
  });

  it("sends the prior list back to the model so an edit can change it, and sends nothing but the conversation and client names", async () => {
    const f = fakeFetch(reply({ reply: "ok", lines: [] }));
    await handleChat({
      messages: [user("pulpen 10"), { role: "assistant", content: "Oke", lines: [{ name: "Pulpen", qty: 10 }] }, user("jadi 20")],
      clients: ["Maju Jaya"],
    }, { apiKey: "secret-key", fetchFn: f.fn });
    const sent = JSON.parse(f.calls[0].init.body as string);
    expect(sent.contents.map((c: { role: string }) => c.role)).toEqual(["user", "model", "user"]);
    expect(sent.contents[1].parts[0].text).toContain('"name":"Pulpen"');
    expect(sent.systemInstruction.parts[0].text).toContain("Maju Jaya");
    expect(Object.keys(sent).sort()).toEqual(["contents", "generationConfig", "systemInstruction"]);
    expect(sent.generationConfig.responseSchema.properties.lines).toBeDefined();
    expect((f.calls[0].init.headers as Record<string, string>)["x-goog-api-key"]).toBe("secret-key");
    expect(f.calls[0].url).not.toContain("secret-key");
  });

  it("drops prices and extra fields the model adds, and a client it was not told about", async () => {
    const f = fakeFetch(reply({
      reply: "ok", client: "PT Karangan", lines: [{ name: "Pulpen", qty: 5, price: 1, cogs: 0, manualPrice: [1, 1, 1] }], discount: 100,
    }));
    const r = await handleChat({ messages: [user("pulpen 5")], clients: ["Maju Jaya"] }, { apiKey: "k", fetchFn: f.fn });
    const json = JSON.parse(JSON.stringify(r.json));
    expect(json).toEqual({ reply: "ok", lines: [{ name: "Pulpen", qty: 5 }] });
  });

  it("says so on malformed JSON, a wrong shape and upstream errors", async () => {
    const run = (body: unknown, status = 200) => handleChat({ messages: [user("halo")] }, { apiKey: "k", fetchFn: fakeFetch(body, status).fn });
    expect((await run(reply("nope {"))).status).toBe(502);
    expect((await run(reply({ reply: 1 }))).status).toBe(502);
    expect((await run({}, 429)).status).toBe(429);
    expect((await run({}, 403)).status).toBe(502);
    expect((await run({}, 500)).status).toBe(502);
  });
});

describe("pickClient", () => {
  const list = ["BAHTERA ADI JAYA PT", "Maju Jaya CV", "Maju Jaya"];
  it("matches regardless of case, punctuation and PT/CV, to the listed spelling", () => {
    expect(pickClient("PT. Bahtera Adi Jaya", list)).toBe("BAHTERA ADI JAYA PT");
  });
  it("drops unknown, empty and ambiguous names", () => {
    expect(pickClient("PT Lain", list)).toBeUndefined();
    expect(pickClient("", list)).toBeUndefined();
    expect(pickClient(undefined, list)).toBeUndefined();
    expect(pickClient("Maju Jaya", list)).toBeUndefined();
  });
});
