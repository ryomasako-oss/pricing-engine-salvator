// @ts-nocheck — node:sqlite/vitest types are outside tsconfig.worker.json, same as quote-revision-auth.test.ts.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import { D1DatabaseShim } from "../../scripts/d1-sqlite-shim.js";
import { catalogRouter } from "./routes/catalog";
import { itemImageRouter } from "./routes/itemImage";
import { ITEM_IMAGES_STATUS_KEY } from "../../shared/itemImages";
import { getItemImagesStatus } from "./itemImages";

/** R2 palsu: Map di belakang, cukup untuk list() dan get(). */
function fakeR2(files: Record<string, string>) {
  return {
    list: async () => ({ objects: Object.keys(files).map((key) => ({ key })), truncated: false }),
    get: async (key: string) => (files[key] === undefined ? null : { key, body: files[key] }),
  };
}

const WEBP = "RIFF....WEBPVP8 ";

describe("gambar barang di storage sendiri", () => {
  let db: D1DatabaseShim;
  let sqlite: DatabaseSync;
  let app: Hono;
  let bucket: ReturnType<typeof fakeR2>;
  let env: { DB: D1DatabaseShim; IMAGES?: unknown };

  const items = async (e = env) =>
    Object.fromEntries(
      (await (await app.request("/api/catalog", {}, e)).json()).items.map((i: { code: string; image: string | null }) => [
        i.code,
        i.image,
      ]),
    );
  const units = async (codes: string[], e = env) =>
    (
      await app.request(
        "/api/catalog/units",
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ codes }) },
        e,
      )
    ).json();

  beforeAll(() => {
    sqlite = new DatabaseSync(":memory:");
    const dir = path.resolve(import.meta.dirname, "../../migrations");
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort())
      sqlite.exec(readFileSync(path.join(dir, file), "utf8"));
    sqlite.exec(`INSERT INTO catalog_items(code, name, uom, cogs, list_price, stock) VALUES
      ('ATK-1', 'Pulpen', 'Pcs', 1000, 2000, 11),
      ('ATK-2', 'Kertas', 'Rim', 30000, 45000, 22),
      ('ATK-3', 'Map', 'Pcs', 500, 900, 33)`);
    db = new D1DatabaseShim(sqlite);

    app = new Hono();
    app.use(async (c, next) => {
      c.set("user", { id: 1, email: "m@test", name: "Manajer", role: "manager", active: 1, phone: "", created_at: "" });
      await next();
    });
    app.route("/api/catalog", catalogRouter);
    app.route("/api/item-image", itemImageRouter);
  });

  afterAll(() => sqlite.close());

  beforeEach(() => {
    // ATK-1 thumbnail + penuh, ATK-2 hanya penuh, ATK-3 tidak punya gambar.
    bucket = fakeR2({
      "ATK-1-thumb.webp": WEBP + "t1",
      "ATK-1.webp": WEBP + "f1",
      "ATK-2.webp": WEBP + "f2",
      // Tidak akan terhitung: nama berkas di luar pola.
      "readme.txt": "bukan gambar",
      "../rahasia-thumb.webp": WEBP + "x",
    });
    env = { DB: db, IMAGES: bucket };
    sqlite.exec("DELETE FROM item_images");
    sqlite.exec(`DELETE FROM settings WHERE key = '${ITEM_IMAGES_STATUS_KEY}'`);
  });

  it("katalog memberi URL proxy hanya untuk kode yang punya gambar", async () => {
    expect(await items()).toEqual({
      "ATK-1": "/api/item-image/ATK-1-thumb.webp",
      "ATK-2": "/api/item-image/ATK-2-thumb.webp",
      "ATK-3": null,
    });
    expect(await getItemImagesStatus(db)).toMatchObject({ lastError: null, images: 2 });
  });

  it("nama berkas di luar pola tidak pernah masuk daftar", async () => {
    await items();
    const rows = sqlite.prepare("SELECT code FROM item_images ORDER BY code").all() as { code: string }[];
    expect(rows.map((r) => r.code)).toEqual(["ATK-1", "ATK-2"]);
  });

  it("bucket yang belum ada = katalog tanpa gambar, bukan error", async () => {
    expect(await items({ DB: db })).toEqual({ "ATK-1": null, "ATK-2": null, "ATK-3": null });
    expect((await units(["ATK-1"], { DB: db })).images).toEqual({});
    expect(await getItemImagesStatus(db)).toMatchObject({ images: 0, lastError: null });
  });

  it("/catalog/units mengirim peta gambar untuk baris quotation", async () => {
    expect((await units(["ATK-1", "ATK-3"])).images).toEqual({ "ATK-1": "/api/item-image/ATK-1-thumb.webp" });
  });

  it("proxy melayani thumbnail dan gambar penuh", async () => {
    const thumb = await app.request("/api/item-image/ATK-1-thumb.webp", {}, env);
    expect(thumb.status).toBe(200);
    expect(thumb.headers.get("content-type")).toBe("image/webp");
    expect(await thumb.text()).toBe(WEBP + "t1");
    expect(await (await app.request("/api/item-image/ATK-1.webp", {}, env)).text()).toBe(WEBP + "f1");
  });

  it("hanya ada gambar penuh: nama -thumb dilayani dari gambar penuh", async () => {
    const fallback = await app.request("/api/item-image/ATK-2-thumb.webp", {}, env);
    expect(fallback.status).toBe(200);
    expect(await fallback.text()).toBe(WEBP + "f2");
  });

  it("hanya ada thumbnail: nama gambar penuh dilayani dari thumbnail", async () => {
    bucket = fakeR2({ "ATK-9-thumb.webp": WEBP + "t9" });
    env = { DB: db, IMAGES: bucket };
    const full = await app.request("/api/item-image/ATK-9.webp", {}, env);
    expect(full.status).toBe(200);
    expect(await full.text()).toBe(WEBP + "t9");
  });

  it("proxy menolak nama berkas di luar pola dan path traversal", async () => {
    for (const bad of ["readme.txt", "../rahasia-thumb.webp", "a..b-thumb.webp", "%2e%2e%2fsecrets.webp"]) {
      expect((await app.request(`/api/item-image/${bad}`, {}, env)).status).toBe(404);
    }
  });

  it("proxy menolak pemanggil yang belum masuk", async () => {
    const anon = new Hono();
    anon.route("/api/item-image", itemImageRouter);
    expect((await anon.request("/api/item-image/ATK-1-thumb.webp", {}, env)).status).toBe(401);
  });

  it("bucket gagal dibaca: daftar lama dipakai dan errornya dicatat", async () => {
    await items();
    sqlite.exec(
      `UPDATE settings SET value = '{"lastSyncAt":"2026-01-01T00:00:00.000Z","lastAttemptAt":"2026-01-01T00:00:00.000Z","lastError":null,"images":2}' WHERE key = '${ITEM_IMAGES_STATUS_KEY}'`,
    );
    const broken = { DB: db, IMAGES: { list: async () => { throw new Error("R2 tidak bisa dibaca"); }, get: async () => null } };
    expect(await items(broken)).toEqual({
      "ATK-1": "/api/item-image/ATK-1-thumb.webp",
      "ATK-2": "/api/item-image/ATK-2-thumb.webp",
      "ATK-3": null,
    });
    expect((await getItemImagesStatus(db)).lastError).toMatch(/R2 tidak bisa dibaca/);
  });
});