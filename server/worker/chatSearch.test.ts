import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { AlwaysAllowRateLimit, D1DatabaseShim } from "../../scripts/d1-sqlite-shim";
import { chatRouter } from "./routes/chat";
import type { Role } from "../../shared/types";
import type { Env } from "./env";

/* Catalog lookups from the Home chat, through the real route: the cost gate must hold on the server. */

function setup(fillers = 0) {
  const sqlite = new DatabaseSync(":memory:");
  const dir = path.resolve(import.meta.dirname, "../../migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(path.join(dir, f), "utf8"));
  const add = sqlite.prepare("INSERT INTO catalog_items(code, name, uom, cogs, list_price, stock) VALUES(?, ?, ?, ?, ?, ?)");
  add.run("K1", "Kertas A4 70gr", "Rim", 19000, 30000, 12);
  add.run("K2", "Kertas F4 70gr", "Rim", 21500, 32000, 0);
  add.run("P1", "Pulpen Hitam", "Pcs", 2500, 4000, 300);
  add.run("Z0", "Map Rekam Medis", "Pcs", 0, 5000, 40);
  add.run("UP", "Lakban Bening", "Roll", 9000, 8000, 5);
  add.run("JU", "Tinta Printer", "Btl", 10000, 50000, 3);
  for (let i = 0; i < fillers; i++) add.run(`F${i}`, `Filler ${i}`, "Pcs", 1000, 2000, 1);
  // Reference stays at the first COGS (0010); a later import jumps it +100%.
  sqlite.prepare("UPDATE catalog_items SET cogs = 20000 WHERE code = 'JU'").run();
  const env = {
    DB: new D1DatabaseShim(sqlite) as unknown as D1Database,
    ASSISTANT_LIMITER: new AlwaysAllowRateLimit(),
    GEMINI_API_KEY: "k",
  } as unknown as Env["Bindings"];
  return async (role: Role, search: unknown, text = "cari") => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ reply: "Ini hasilnya.", lines: [], search }) }] } }] })),
    );
    const a = new Hono<Env>();
    a.use(async (c, next) => {
      c.set("user", { id: 1, email: "x@x", name: "X", role } as never);
      await next();
    });
    a.route("/api/chat", chatRouter);
    const r = await a.request("/api/chat", { method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: text }] }), headers: { "content-type": "application/json" } }, env);
    return { status: r.status, json: (await r.json()) as Record<string, any> };
  };
}

afterEach(() => vi.restoreAllMocks());

describe("chat catalog search", () => {
  it("a manager finds items by COGS range, with COGS in the rows", async () => {
    const r = await setup()("manager", { kind: "catalog" }, "carikan barang dengan cogs sekitar 20 ribu");
    expect(r.status).toBe(200);
    expect(r.json.found.total).toBe(3);
    expect(Object.fromEntries(r.json.found.items.map((i: any) => [i.code, i.cogs]))).toEqual({ K1: 19000, K2: 21500, JU: 20000 });
  });

  it("a rep is refused any COGS filter on the server, even if the model sends one", async () => {
    const go = setup();
    for (const [search, text] of [[{ kind: "catalog" }, "barang cogs di bawah 22rb"], [{ kind: "catalog" }, "hpp di atas 1"], [{ kind: "cogs_problem" }, "cari"]] as const) {
      const r = await go("rep", search, text);
      expect(r.status).toBe(200);
      expect(r.json.found).toBeUndefined();
      expect(r.json.reply).toContain("hanya bisa dipakai manajer");
    }
  });

  it("a rep can look up stock by name, and the rows carry no COGS", async () => {
    const r = await setup()("rep", { kind: "catalog", q: "kertas" });
    expect(r.json.found.items).toEqual([
      { code: "K1", name: "Kertas A4 70gr", uom: "Rim", stock: 12 },
      { code: "K2", name: "Kertas F4 70gr", uom: "Rim", stock: 0 },
    ]);
    expect(JSON.stringify(r.json)).not.toMatch(/cogs|19000|21500/i);
  });

  it("shows one page of 20 but counts every match", async () => {
    const r = await setup(25)("rep", { kind: "catalog", q: "filler" });
    expect(r.json.found.total).toBe(25);
    expect(r.json.found.items).toHaveLength(20);
    expect((await setup()("rep", { kind: "catalog", q: "kertas" })).json.found.total).toBe(2);
  });

  it("outOfStock lists only items out of stock", async () => {
    const r = await setup()("rep", { kind: "catalog", outOfStock: true });
    expect(r.json.found.items.map((i: any) => i.code)).toEqual(["K2"]);
  });

  it("cogs_problem lists the three signs of shared/cogsCheck and nothing else", async () => {
    const r = await setup()("manager", { kind: "cogs_problem" });
    const byCode = Object.fromEntries(r.json.found.items.map((i: any) => [i.code, i.problem]));
    expect(Object.keys(byCode).sort()).toEqual(["JU", "UP", "Z0"]);
    expect(byCode.Z0).toBe("COGS kosong di katalog");
    expect(byCode.UP).toContain("lebih tinggi dari harga jual");
    expect(byCode.JU).toContain("berubah 100%");
  });

  it("a malformed search from the model is dropped, not run", async () => {
    const r = await setup()("manager", { kind: "drop_table", q: "x" });
    expect(r.status).toBe(200);
    expect(r.json.found).toBeUndefined();
    expect(r.json.reply).toBe("Ini hasilnya.");
  });
});
