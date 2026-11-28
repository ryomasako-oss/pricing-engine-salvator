// @ts-nocheck — node:sqlite/vitest types are outside tsconfig.worker.json, same as item-image-upload.test.ts.
/* 2026-11-28: foto untuk barang baru yang didaftarkan dari quotation (masih menunggu Accurate). */
import { beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import { D1DatabaseShim } from "../../scripts/d1-sqlite-shim.js";
import { itemImageRouter } from "./routes/itemImage";
import { pendingItemsRouter } from "./routes/pendingItems";

function fakeR2() {
  const files = new Map<string, string>();
  return {
    files,
    put: async (key: string, body: Uint8Array | ArrayBuffer) => void files.set(key, new TextDecoder().decode(body)),
    delete: async (keys: string[]) => keys.forEach((k) => files.delete(k)),
    get: async (key: string) =>
      files.has(key) ? { key, body: files.get(key), arrayBuffer: async () => new TextEncoder().encode(files.get(key)).buffer } : null,
  };
}

const webp = (tail: string) => new Blob([`RIFF....WEBP${tail}`], { type: "image/webp" });
const form = (tail: string) => {
  const f = new FormData();
  f.set("full", webp(`full-${tail}`));
  f.set("thumb", webp(`thumb-${tail}`));
  return f;
};

type Who = "sales1" | "sales2" | "manager";
const USERS: Record<Who, { id: number; role: string }> = { sales1: { id: 1, role: "rep" }, sales2: { id: 2, role: "rep" }, manager: { id: 3, role: "manager" } };

function setup() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = path.resolve(import.meta.dirname, "../../migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(path.join(dir, f), "utf8"));
  for (const [name, u] of Object.entries(USERS)) sqlite.exec(`INSERT INTO users(id, email, name, role, password_hash) VALUES (${u.id}, '${name}@x', '${name}', '${u.role}', 'x')`);
  sqlite.exec(`INSERT INTO catalog_items(code, name, uom, cogs, list_price, stock) VALUES ('ATK-1', 'Pulpen', 'Pcs', 1000, 2000, 1), ('ATK-2', 'Kertas', 'Rim', 1, 2, 1)`);
  let who: Who = "sales1";
  const app = new Hono();
  app.use(async (c, next) => {
    c.set("user", { id: USERS[who].id, email: `${who}@x`, name: who, role: USERS[who].role, active: 1, phone: "", created_at: "" });
    await next();
  });
  app.route("/api/item-image", itemImageRouter);
  app.route("/api/pending-items", pendingItemsRouter);
  const bucket = fakeR2();
  const env = { DB: new D1DatabaseShim(sqlite), IMAGES: bucket };
  const as = (w: Who) => {
    who = w;
    return {
      upload: (code: string, tail = "a") => app.request(`/api/item-image/${code}`, { method: "POST", body: form(tail) }, env),
      remove: (code: string) => app.request(`/api/item-image/${code}`, { method: "DELETE" }, env),
      json: async (method: string, url: string, body?: unknown) => {
        const r = await app.request(url, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }, env);
        return { status: r.status, json: await r.json() };
      },
    };
  };
  const newItem = async (name = "Stapler jumbo") => (await as("sales1").json("POST", "/api/pending-items", { name, uom: "Pcs" })).json.item;
  return { sqlite, bucket, as, newItem };
}

describe("foto barang baru dari quotation", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => (t = setup()));

  it("peminta mengunggah foto barang barunya; daftar barang baru tahu barang itu sudah berfoto", async () => {
    const item = await t.newItem();
    expect(item.code).toBe("BARU-0001");
    expect((await t.as("sales1").upload("BARU-0001")).status).toBe(200);
    expect([...t.bucket.files.keys()].sort()).toEqual(["BARU-0001-thumb.webp", "BARU-0001.webp"]);
    const list = await t.as("sales1").json("GET", "/api/pending-items");
    expect(list.json.items[0]).toMatchObject({ code: "BARU-0001", has_image: 1 });
    expect(t.sqlite.prepare("SELECT entity, action FROM audit_log WHERE action = 'image_set'").all()).toEqual([{ entity: "pending_item", action: "image_set" }]);
  });

  it("sales lain tidak bisa; manajer bisa; sales tetap tidak bisa mengubah foto barang katalog", async () => {
    await t.newItem();
    expect((await t.as("sales2").upload("BARU-0001")).status).toBe(403);
    expect((await t.as("sales2").remove("BARU-0001")).status).toBe(403);
    expect((await t.as("manager").upload("BARU-0001")).status).toBe(200);
    expect((await t.as("sales1").upload("ATK-1")).status).toBe(403);
    expect((await t.as("sales1").upload("TIDAK-ADA")).status).toBe(404);
  });

  it("permintaan yang dibatalkan tidak bisa diberi foto lagi", async () => {
    const item = await t.newItem();
    await t.as("manager").json("POST", `/api/pending-items/${item.id}/cancel`);
    expect((await t.as("sales1").upload("BARU-0001")).status).toBe(404);
  });

  it("disambungkan ke kode Accurate lain: foto ikut pindah ke kode itu", async () => {
    const item = await t.newItem();
    await t.as("sales1").upload("BARU-0001", "baru");
    const linked = await t.as("manager").json("POST", `/api/pending-items/${item.id}/link`, { code: "ATK-2" });
    expect(linked.status).toBe(200);
    expect(Object.fromEntries(t.bucket.files)).toEqual({ "ATK-2.webp": "RIFF....WEBPfull-baru", "ATK-2-thumb.webp": "RIFF....WEBPthumb-baru" });
    expect(t.sqlite.prepare("SELECT code FROM item_images ORDER BY code").all()).toEqual([{ code: "ATK-2" }]);
  });

  it("kode tujuan sudah punya foto sendiri: foto katalog dipertahankan, foto permintaan dibuang", async () => {
    await t.as("manager").upload("ATK-2", "katalog");
    const item = await t.newItem();
    await t.as("sales1").upload("BARU-0001", "baru");
    await t.as("manager").json("POST", `/api/pending-items/${item.id}/link`, { code: "ATK-2" });
    expect(Object.fromEntries(t.bucket.files)).toEqual({ "ATK-2.webp": "RIFF....WEBPfull-katalog", "ATK-2-thumb.webp": "RIFF....WEBPthumb-katalog" });
    expect(t.sqlite.prepare("SELECT code FROM item_images ORDER BY code").all()).toEqual([{ code: "ATK-2" }]);
  });
});
