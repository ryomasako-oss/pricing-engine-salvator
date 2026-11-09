import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { D1DatabaseShim } from "../../scripts/d1-sqlite-shim";
import { authRouter } from "./routes/auth";
import type { Env } from "./env";

/* The WhatsApp and Telegram numbers are saved on separate forms: saving one must not clear the other. */

function setup() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = path.resolve(import.meta.dirname, "../../migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(path.join(dir, f), "utf8"));
  sqlite.prepare("INSERT INTO users(email, name, password_hash, role, phone) VALUES('r@x', 'Rina', 'x', 'rep', '0812 3456 789')").run();
  const env = { DB: new D1DatabaseShim(sqlite) as unknown as D1Database } as unknown as Env["Bindings"];
  const a = new Hono<Env>();
  a.use(async (c, next) => {
    c.set("user", { id: 1, email: "r@x", name: "Rina", role: "rep" } as never);
    await next();
  });
  a.route("/api/auth", authRouter);
  const patch = async (body: unknown) => {
    const r = await a.request("/api/auth/profile", { method: "PATCH", body: JSON.stringify(body), headers: { "content-type": "application/json" } }, env);
    return { status: r.status, json: (await r.json()) as Record<string, any> };
  };
  const row = () => sqlite.prepare("SELECT phone, telegram_phone FROM users WHERE id = 1").get();
  return { patch, row };
}

describe("PATCH /auth/profile", () => {
  it("saving the Telegram number keeps the WhatsApp number, and the reverse", async () => {
    const t = setup();
    const r = await t.patch({ telegram_phone: "0857 1111 2222" });
    expect(r.status).toBe(200);
    expect(r.json.user.telegram_phone).toBe("0857 1111 2222");
    expect(t.row()).toEqual({ phone: "0812 3456 789", telegram_phone: "0857 1111 2222" });
    await t.patch({ phone: "" });
    expect(t.row()).toEqual({ phone: "", telegram_phone: "0857 1111 2222" });
  });

  it("rejects a malformed number and an empty body", async () => {
    const t = setup();
    expect((await t.patch({ telegram_phone: "abc" })).json.error).toContain("Telegram");
    expect((await t.patch({})).status).toBe(400);
    expect(t.row()).toEqual({ phone: "0812 3456 789", telegram_phone: "" });
  });
});
