// @ts-nocheck — node:sqlite/vitest types are outside tsconfig.worker.json, same as item-images.test.ts.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import { D1DatabaseShim } from "../../scripts/d1-sqlite-shim.js";
import { itemImageRouter, MAX_FULL_BYTES, MAX_THUMB_BYTES } from "./routes/itemImage";

/** R2 palsu dengan put/get/delete dan ETag. */
function fakeR2() {
  const files = new Map<string, string>();
  return {
    files,
    put: async (key: string, body: Uint8Array) => void files.set(key, new TextDecoder().decode(body)),
    delete: async (keys: string[]) => keys.forEach((k) => files.delete(k)),
    get: async (key: string) =>
      files.has(key) ? { key, body: files.get(key), httpEtag: `"${files.get(key)!.length}-${files.get(key)!.slice(-4)}"` } : null,
  };
}

const webp = (tail: string) => new Blob([`RIFF....WEBP${tail}`], { type: "image/webp" });
const form = (full: Blob | string, thumb: Blob | string) => {
  const f = new FormData();
  f.set("full", full);
  f.set("thumb", thumb);
  return f;
};

describe("upload gambar barang dari aplikasi", () => {
  let sqlite: DatabaseSync;
  let db: D1DatabaseShim;
  let app: Hono;
  let role = "manager";
  let bucket: ReturnType<typeof fakeR2>;
  let env: { DB: D1DatabaseShim; IMAGES?: unknown };
  const post = (code: string, body: FormData, e = env) => app.request(`/api/item-image/${code}`, { method: "POST", body }, e);

  beforeAll(() => {
    sqlite = new DatabaseSync(":memory:");
    const dir = path.resolve(import.meta.dirname, "../../migrations");
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort())
      sqlite.exec(readFileSync(path.join(dir, file), "utf8"));
    sqlite.exec(`INSERT INTO users(id, email, name, role, password_hash) VALUES (1, 'm@test', 'M', 'manager', 'x')`);
    sqlite.exec(`INSERT INTO catalog_items(code, name, uom, cogs, list_price, stock) VALUES
      ('ATK-1', 'Pulpen', 'Pcs', 1000, 2000, 1), ('ATK-2', 'Kertas', 'Rim', 1, 2, 1)`);
    db = new D1DatabaseShim(sqlite);
    app = new Hono();
    app.use(async (c, next) => {
      c.set("user", { id: 1, email: "m@test", name: "M", role, active: 1, phone: "", created_at: "" });
      await next();
    });
    app.route("/api/item-image", itemImageRouter);
  });
  afterAll(() => sqlite.close());
  beforeEach(() => {
    role = "manager";
    bucket = fakeR2();
    env = { DB: db, IMAGES: bucket };
    sqlite.exec("DELETE FROM item_images");
  });

  it("manajer dan admin bisa mengunggah; gambar masuk bucket dan daftar langsung", async () => {
    for (role of ["manager", "admin"]) {
      bucket.files.clear();
      const res = await post("ATK-1", form(webp("full"), webp("thumb")));
      expect(res.status).toBe(200);
      expect((await res.json()).image).toBe("/api/item-image/ATK-1-thumb.webp");
      expect([...bucket.files.keys()].sort()).toEqual(["ATK-1-thumb.webp", "ATK-1.webp"]);
    }
    expect(sqlite.prepare("SELECT code FROM item_images").all()).toEqual([{ code: "ATK-1" }]);
    expect(sqlite.prepare("SELECT action FROM audit_log WHERE action = 'image_set'").all().length).toBe(2);
  });

  it("sales tidak boleh mengunggah maupun menghapus", async () => {
    role = "rep";
    expect((await post("ATK-1", form(webp("a"), webp("b")))).status).toBe(403);
    expect((await app.request("/api/item-image/ATK-1", { method: "DELETE" }, env)).status).toBe(403);
    expect(bucket.files.size).toBe(0);
  });

  it("menolak: bukan WebP, terlalu besar, kurang satu berkas, kode tak dikenal", async () => {
    expect((await post("ATK-1", form(new Blob(["bukan gambar"]), webp("t")))).status).toBe(400);
    expect((await post("ATK-1", form(webp("x".repeat(MAX_FULL_BYTES)), webp("t")))).status).toBe(413);
    expect((await post("ATK-1", form(webp("f"), webp("x".repeat(MAX_THUMB_BYTES))))).status).toBe(413);
    const half = new FormData();
    half.set("full", webp("f"));
    expect((await post("ATK-1", half)).status).toBe(400);
    expect((await post("TIDAK-ADA", form(webp("f"), webp("t")))).status).toBe(404);
    expect((await post("ATK-1-thumb", form(webp("f"), webp("t")))).status).toBe(404);
    expect(bucket.files.size).toBe(0);
    expect(sqlite.prepare("SELECT code FROM item_images").all()).toEqual([]);
  });

  it("bucket belum aktif: 503, bukan error mentah", async () => {
    expect((await post("ATK-1", form(webp("f"), webp("t")), { DB: db })).status).toBe(503);
  });

  it("hapus membuang kedua berkas dan barisnya", async () => {
    await post("ATK-1", form(webp("f"), webp("t")));
    const res = await app.request("/api/item-image/ATK-1", { method: "DELETE" }, env);
    expect(res.status).toBe(200);
    expect(bucket.files.size).toBe(0);
    expect(sqlite.prepare("SELECT code FROM item_images").all()).toEqual([]);
  });

  it("gambar pengganti langsung terlihat: ETag dan no-cache, 304 bila belum berubah", async () => {
    await post("ATK-1", form(webp("lama"), webp("lama")));
    const first = await app.request("/api/item-image/ATK-1.webp", {}, env);
    expect(first.headers.get("cache-control")).toBe("private, no-cache");
    const etag = first.headers.get("etag");
    const same = await app.request("/api/item-image/ATK-1.webp", { headers: { "If-None-Match": etag } }, env);
    expect(same.status).toBe(304);
    await post("ATK-1", form(webp("baru!!"), webp("baru!!")));
    const changed = await app.request("/api/item-image/ATK-1.webp", { headers: { "If-None-Match": etag } }, env);
    expect(changed.status).toBe(200);
    expect(await changed.text()).toContain("baru!!");
  });

  it("_check: kode resmi katalog (huruf besar-kecil sama) dan apakah sudah punya gambar", async () => {
    await post("ATK-1", form(webp("f"), webp("t")));
    const res = await app.request(
      "/api/item-image/_check",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ codes: ["atk-1", "ATK-2", "TIDAK-ADA"] }) },
      env,
    );
    expect(res.status).toBe(200);
    const items = (await res.json()).items.sort((a, b) => a.code.localeCompare(b.code));
    expect(items).toEqual([
      { input: "atk-1", code: "ATK-1", hasImage: true },
      { input: "ATK-2", code: "ATK-2", hasImage: false },
    ]);
  });

  it("unggah satuan memakai kode resmi katalog walau huruf nama berkas beda", async () => {
    const res = await post("atk-1", form(webp("f"), webp("t")));
    expect(res.status).toBe(200);
    expect([...bucket.files.keys()].sort()).toEqual(["ATK-1-thumb.webp", "ATK-1.webp"]);
  });

  it("_check: sales ditolak, lebih dari 500 kode ditolak", async () => {
    const call = (codes) =>
      app.request("/api/item-image/_check", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ codes }) }, env);
    expect((await call(Array.from({ length: 501 }, (_, i) => `K${i}`))).status).toBe(400);
    role = "rep";
    expect((await call(["ATK-1"])).status).toBe(403);
  });
});
