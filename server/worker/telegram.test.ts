import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AlwaysAllowRateLimit, D1DatabaseShim } from "../../scripts/d1-sqlite-shim";
import { handleUpdate, normalizePhone, telegramRouter } from "./routes/telegram";
import { Hono } from "hono";
import type { Env } from "./env";

/* Silvy on Telegram: only a linked, active user reaches Gemini; the cost gate is the Home chat's. */

const ME = 777;

function setup() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = path.resolve(import.meta.dirname, "../../migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(path.join(dir, f), "utf8"));
  const addUser = sqlite.prepare("INSERT INTO users(email, name, password_hash, role, phone) VALUES(?, ?, 'x', ?, ?)");
  addUser.run("rep@x", "Rina", "rep", "0812-3456-789");
  addUser.run("mgr@x", "Mira", "manager", "+62 811 000 111");
  sqlite.prepare("INSERT INTO catalog_items(code, name, uom, cogs, list_price, stock) VALUES('K1', 'Kertas A4', 'Rim', 19000, 30000, 12)").run();
  const env = {
    DB: new D1DatabaseShim(sqlite) as unknown as D1Database,
    ASSISTANT_LIMITER: new AlwaysAllowRateLimit(),
    GEMINI_API_KEY: "k",
    TELEGRAM_BOT_TOKEN: "t",
    TELEGRAM_WEBHOOK_SECRET: "s",
    APP_URL: "https://app.test",
  } as unknown as Env["Bindings"];
  const sent: string[] = [];
  let gemini: Record<string, unknown> = { reply: "Siap.", lines: [] };
  const geminiCalls: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    if (String(url).includes("api.telegram.org")) {
      sent.push(JSON.parse(String(init!.body)).text);
      return new Response("{}");
    }
    geminiCalls.push(String(init!.body));
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(gemini) }] } }] }));
  });
  const say = (m: Record<string, unknown>) => handleUpdate(env, { message: { chat: { id: ME, type: "private" }, from: { id: ME }, ...m } as never });
  return { env, sqlite, sent, geminiCalls, say, answer: (a: Record<string, unknown>) => (gemini = a) };
}

afterEach(() => vi.restoreAllMocks());

describe("normalizePhone", () => {
  it("treats local, +62 and spaced forms as one number", () => {
    expect(normalizePhone("0812-3456-789")).toBe("628123456789");
    expect(normalizePhone("+62 812 3456 789")).toBe("628123456789");
    expect(normalizePhone("628123456789")).toBe("628123456789");
  });
});

describe("Silvy on Telegram", () => {
  it("an unlinked account only gets the share-your-number prompt, and Gemini is not called", async () => {
    const t = setup();
    await t.say({ text: "cari kertas" });
    expect(t.sent[0]).toContain("Bagikan nomor saya");
    expect(t.geminiCalls).toHaveLength(0);
  });

  it("refuses someone else's contact and an unknown number", async () => {
    const t = setup();
    await t.say({ contact: { phone_number: "628123456789", user_id: 999 } });
    await t.say({ contact: { phone_number: "62899999", user_id: ME } });
    expect(t.sent[0]).toContain("nomor Anda sendiri");
    expect(t.sent[1]).toContain("belum terdaftar");
    expect(t.sqlite.prepare("SELECT COUNT(*) AS n FROM users WHERE telegram_id IS NOT NULL").get()).toEqual({ n: 0 });
  });

  it("links by own phone, chats, and saves the list as a draft the app opens", async () => {
    const t = setup();
    await t.say({ contact: { phone_number: "628123456789", user_id: ME } });
    expect(t.sent[0]).toContain("Terhubung sebagai Rina");
    t.answer({ reply: "Siap, saya catat.", lines: [{ name: "Pulpen hitam", qty: 10, uom: "Lusin" }] });
    await t.say({ text: "pulpen hitam 10 lusin" });
    expect(t.sent[1]).toContain("1. Pulpen hitam — 10 Lusin");
    // The next turn carries the list back to the model.
    await t.say({ text: "tambah kertas" });
    expect(t.geminiCalls[1]).toContain("Pulpen hitam");
    await t.say({ text: "/simpan" });
    expect(t.sent[3]).toMatch(/https:\/\/app\.test\/\?draft=\d+/);
    const d = t.sqlite.prepare("SELECT lines, choices, created_by FROM list_drafts").get() as Record<string, string | number>;
    expect(JSON.parse(String(d.lines))[0].name).toBe("Pulpen hitam");
    expect(d.choices).toBe("[]");
    expect(d.created_by).toBe(1);
  });

  it("a rep gets no COGS from a catalog search; a manager does", async () => {
    const t = setup();
    await t.say({ contact: { phone_number: "628123456789", user_id: ME } });
    t.answer({ reply: "Ini hasilnya.", lines: [], search: { kind: "catalog", q: "kertas" } });
    await t.say({ text: "stok kertas" });
    expect(t.sent[1]).toContain("K1 Kertas A4 (Rim) stok 12");
    expect(t.sent[1]).not.toMatch(/COGS|19\.000/);
    await t.say({ contact: { phone_number: "+62811000111", user_id: ME } });
    await t.say({ text: "stok kertas" });
    expect(t.sent[3]).toContain("COGS Rp19.000");
  });

  it("an account deactivated after linking is cut off", async () => {
    const t = setup();
    await t.say({ contact: { phone_number: "628123456789", user_id: ME } });
    t.sqlite.prepare("UPDATE users SET active = 0 WHERE id = 1").run();
    await t.say({ text: "halo" });
    expect(t.sent[1]).toContain("Bagikan nomor saya");
    expect(t.geminiCalls).toHaveLength(0);
  });

  it("the webhook rejects a call without Telegram's secret header", async () => {
    const t = setup();
    const a = new Hono<Env>().route("/api/telegram", telegramRouter);
    const r = await a.request("/api/telegram/webhook", { method: "POST", body: "{}" }, t.env);
    expect(r.status).toBe(401);
  });
});
