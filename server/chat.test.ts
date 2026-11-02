import { describe, expect, it } from "vitest";
import { cogsFilterFrom, handleChat, pickClient } from "./chat.js";

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

  it("tells the model its name is Silvy", async () => {
    const f = fakeFetch(reply({ reply: "Halo, saya Silvy.", lines: [] }));
    await handleChat({ messages: [user("kamu siapa?")] }, { apiKey: "k", fetchFn: f.fn });
    const system = JSON.parse(f.calls[0].init.body as string).systemInstruction.parts[0].text as string;
    expect(system).toContain("Namamu Silvy");
  });

  it("lets the model suggest a typical list for a client type, without qty, while still banning prices", async () => {
    const f = fakeFetch(reply({ reply: "Usulan umum untuk rumah sakit.", lines: [{ name: "Map rekam medis" }] }));
    const r = await handleChat({ messages: [user("buatin list untuk client rumah sakit")] }, { apiKey: "k", fetchFn: f.fn });
    const system = JSON.parse(f.calls[0].init.body as string).systemInstruction.parts[0].text as string;
    expect(system).toContain("usulan daftar untuk jenis klien");
    expect(system).toContain("tanpa qty dan tanpa satuan");
    expect(system).toContain("Jangan pernah menyebut, menebak, atau membahas angka harga");
    // A suggested row has no qty, so it stays flagged for the rep to fill in.
    expect(r.json).toEqual({ reply: "Usulan umum untuk rumah sakit.", lines: [{ name: "Map rekam medis", qty: 1, noQty: true }] });
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

describe("handleChat catalog search", () => {
  const sys = (f: ReturnType<typeof fakeFetch>) => JSON.parse(f.calls[0].init.body as string).systemInstruction.parts[0].text as string;

  it("tells the model whether this user may filter on COGS", async () => {
    const rep = fakeFetch(reply({ reply: "ok", lines: [] }));
    await handleChat({ messages: [user("cari")] }, { apiKey: "k", fetchFn: rep.fn });
    expect(sys(rep)).toContain("tidak boleh melihat COGS");
    const mgr = fakeFetch(reply({ reply: "ok", lines: [] }));
    await handleChat({ messages: [user("cari")] }, { apiKey: "k", fetchFn: mgr.fn }, true);
    expect(sys(mgr)).toContain("Pengguna ini manajer");
  });

  it("passes a well-formed search through, trimmed, and drops a malformed one", async () => {
    const run = async (search: unknown, text = "cari") =>
      (await handleChat({ messages: [user(text)] }, { apiKey: "k", fetchFn: fakeFetch(reply({ reply: "ok", lines: [], search })).fn }, true)).json;
    expect(await run({ kind: "catalog", q: "  kertas ", outOfStock: true })).toEqual({ reply: "ok", lines: [], search: { kind: "catalog", q: "kertas", stockMax: 0 } });
    // The COGS range comes from the user's words; a number the model puts in the search is ignored.
    expect(await run({ kind: "catalog", cogsMax: 1, stockMax: 0 }, "barang cogs 20 ribu")).toEqual({ reply: "ok", lines: [], search: { kind: "catalog", cogsMin: 18000, cogsMax: 22000 } });
    expect(await run({ kind: "catalog", q: "20000" }, "average cogs di 20 ribu")).toEqual({ reply: "ok", lines: [], search: { kind: "catalog", cogsMin: 18000, cogsMax: 22000 } });
    expect(await run({ kind: "catalog", q: "A4" })).toEqual({ reply: "ok", lines: [], search: { kind: "catalog", q: "A4" } });
    for (const bad of [{ kind: "sql" }, { kind: "catalog", q: "x".repeat(101) }, "catalog"]) expect(await run(bad)).toEqual({ reply: "ok", lines: [] });
  });

  it("reads the COGS filter from the user's words", () => {
    expect(cogsFilterFrom("carikan barang dengan average cogs di 20 ribu")).toEqual({ cogsMin: 18000, cogsMax: 22000 });
    expect(cogsFilterFrom("kertas yang cogs di bawah 30rb ada apa aja")).toEqual({ cogsMax: 30000 });
    expect(cogsFilterFrom("pulpen yang cogs nya di atas 5000")).toEqual({ cogsMin: 5000 });
    expect(cogsFilterFrom("hpp kurang dari 20.000")).toEqual({ cogsMax: 20000 });
    expect(cogsFilterFrom("modal lebih dari 1,5 jt")).toEqual({ cogsMin: 1500000 });
    expect(cogsFilterFrom("COGS sekitar 12k")).toEqual({ cogsMin: 10800, cogsMax: 13200 });
    // No COGS word, or no amount after it: no filter (so "pulpen 10 lusin" never becomes one).
    expect(cogsFilterFrom("pulpen 10 lusin, kertas A4 5 rim")).toEqual({});
    expect(cogsFilterFrom("barang apa aja yang COGS-nya bermasalah?")).toEqual({});
    expect(cogsFilterFrom("cek stok kertas A4")).toEqual({});
  });
});
