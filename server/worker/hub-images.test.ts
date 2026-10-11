// @ts-nocheck — node:sqlite/vitest types are outside tsconfig.worker.json, same as quote-revision-auth.test.ts.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import { D1DatabaseShim } from "../../scripts/d1-sqlite-shim.js";
import { catalogRouter } from "./routes/catalog";
import { hubMediaRouter } from "./routes/hubMedia";
import { HUB_IMAGES_STATUS_KEY } from "../../shared/hubImages";
import { getHubImagesStatus } from "./hubImages";

const IMG_1 = "1-aaaaaaaaaaaaaaaa";
const IMG_2 = "2-bbbbbbbbbbbbbbbb";

/** Data Hub palsu: /v1/products (gambar saja) dan /media publik. */
function startFakeHub(apiKey: string) {
  const state = { down: false, productsForbidden: false, mediaHits: [] as string[] };
  let hubUrl = "";
  const server = createServer((req, res) => {
    const url = new URL(req.url!, "http://hub");
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (state.down) return send(503, { error: "Hub sedang perawatan" });
    if (url.pathname.startsWith("/media/products/")) {
      state.mediaHits.push(url.pathname);
      res.writeHead(200, { "content-type": "image/webp" });
      return res.end(`gambar:${url.pathname}`);
    }
    if (req.headers.authorization !== `Bearer ${apiKey}`) return send(401, { error: "API key tidak valid" });
    if (url.pathname === "/v1/products") {
      if (state.productsForbidden) return send(403, { error: "API key tidak punya izin products:read" });
      const media = (file: string) => ({
        url: `${hubUrl}/media/products/${file}.webp`,
        thumbUrl: `${hubUrl}/media/products/${file}-thumb.webp`,
      });
      const data = [
        { sku: "ATK-1", aliasCodes: [], images: [media(IMG_1)] },
        // Kode alias ikut memakai gambar induknya.
        { sku: "ATK-2", aliasCodes: ["ATK-3"], images: [media(IMG_2)] },
        // URL di luar /media/products Hub tidak boleh disalin.
        { sku: "ATK-9", aliasCodes: [], images: [{ url: "https://lain.example/x.webp", thumbUrl: "https://lain.example/x.webp" }] },
      ];
      return send(200, { data, page: 1, pageSize: 500, total: data.length });
    }
    send(404, { error: "tidak ada" });
  });
  return new Promise<{ state: typeof state; url: string; close: () => void }>((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      hubUrl = `http://127.0.0.1:${server.address().port}`;
      resolve({ state, url: hubUrl, close: () => server.close() });
    }),
  );
}

describe("gambar barang dari Data Hub", () => {
  const API_KEY = "hub_test_key";
  let hub: Awaited<ReturnType<typeof startFakeHub>>;
  let db: D1DatabaseShim;
  let sqlite: DatabaseSync;
  let app: Hono;
  let env: { DB: D1DatabaseShim; HUB_API_URL?: string; HUB_API_KEY?: string };

  const items = async (e = env) => {
    const body = await (await app.request("/api/catalog", {}, e)).json();
    return Object.fromEntries(body.items.map((i: { code: string; image: string | null }) => [i.code, i.image]));
  };
  const units = async (codes: string[], e = env) =>
    (
      await app.request("/api/catalog/units", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ codes }) }, e)
    ).json();

  beforeAll(async () => {
    hub = await startFakeHub(API_KEY);
    sqlite = new DatabaseSync(":memory:");
    const dir = path.resolve(import.meta.dirname, "../../migrations");
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(path.join(dir, file), "utf8"));
    sqlite.exec(`INSERT INTO catalog_items(code, name, uom, cogs, list_price, stock) VALUES
      ('ATK-1', 'Pulpen', 'Pcs', 1000, 2000, 11),
      ('ATK-2', 'Kertas', 'Rim', 30000, 45000, 22),
      ('ATK-3', 'Map', 'Pcs', 500, 900, 33)`);
    db = new D1DatabaseShim(sqlite);
    sqlite.exec(`INSERT INTO users(id, email, name, password_hash, role) VALUES
      (1, 'm@test', 'Manajer', 'x', 'manager'), (2, 'r@test', 'Sales', 'x', 'rep')`);
    env = { DB: db, HUB_API_URL: hub.url, HUB_API_KEY: API_KEY };

    app = new Hono();
    app.use(async (c, next) => {
      c.set("user", { id: 1, email: "m@test", name: "Manajer", role: "manager", active: 1, phone: "", created_at: "" });
      await next();
    });
    app.route("/api/catalog", catalogRouter);
    app.route("/api/hub-media", hubMediaRouter);
  });

  afterAll(() => hub.close());

  beforeEach(() => {
    hub.state.down = false;
    hub.state.productsForbidden = false;
    sqlite.exec(`DELETE FROM hub_images`);
    sqlite.exec(`DELETE FROM settings WHERE key = '${HUB_IMAGES_STATUS_KEY}'`);
  });

  it("tanpa konfigurasi Hub tidak ada gambar sama sekali", async () => {
    expect(await items({ DB: db })).toEqual({ "ATK-1": null, "ATK-2": null, "ATK-3": null });
    expect((await units(["ATK-1"], { DB: db })).images).toEqual({});
  });

  it("katalog memberi URL proxy untuk kode yang punya gambar, kode lain null", async () => {
    expect(await items()).toEqual({
      "ATK-1": `/api/hub-media/${IMG_1}-thumb.webp`,
      "ATK-2": `/api/hub-media/${IMG_2}-thumb.webp`,
      "ATK-3": `/api/hub-media/${IMG_2}-thumb.webp`,
    });
  });

  it("URL gambar di luar /media/products Hub tidak ikut tersalin", async () => {
    await items();
    expect(await getHubImagesStatus(db)).toMatchObject({ lastError: null, images: 3 });
    const rows = sqlite.prepare("SELECT code FROM hub_images ORDER BY code").all() as { code: string }[];
    expect(rows.map((r) => r.code)).toEqual(["ATK-1", "ATK-2", "ATK-3"]);
  });

  it("/catalog/units mengirim peta gambar untuk baris quotation", async () => {
    expect((await units(["ATK-1", "ATK-9"])).images).toEqual({ "ATK-1": `/api/hub-media/${IMG_1}-thumb.webp` });
  });

  it("proxy meneruskan berkas sah dan menolak nama berkas di luar pola", async () => {
    const ok = await app.request(`/api/hub-media/${IMG_1}-thumb.webp`, {}, env);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("image/webp");
    expect(await ok.text()).toContain(IMG_1);
    expect(hub.state.mediaHits).toContain(`/media/products/${IMG_1}-thumb.webp`);

    for (const bad of ["../hub_images", "not-a-hash.webp", "1-zz-thumb.webp", "%2e%2e%2fsecrets"]) {
      expect((await app.request(`/api/hub-media/${bad}`, {}, env)).status).toBe(404);
    }
  });

  it("proxy menolak pemanggil yang belum masuk", async () => {
    const anon = new Hono();
    anon.route("/api/hub-media", hubMediaRouter);
    expect((await anon.request(`/api/hub-media/${IMG_1}-thumb.webp`, {}, env)).status).toBe(401);
  });

  it("Hub sedang rusak: gambar lama tetap dipakai, status mencatat errornya", async () => {
    await items();
    hub.state.down = true;
    sqlite.exec(`UPDATE settings SET value = '{"lastSyncAt":"2026-01-01T00:00:00.000Z","lastAttemptAt":"2026-01-01T00:00:00.000Z","lastError":null,"images":3}'
                 WHERE key = '${HUB_IMAGES_STATUS_KEY}'`);
    // Percobaan lama (> TTL) memicu tarikan baru; Hub mati, jadi salinan lama harus tetap utuh.
    await items();
    expect(await getHubImagesStatus(db)).toMatchObject({ images: 3 });
    expect((await getHubImagesStatus(db)).lastError).toMatch(/Data Hub menolak \(HTTP 503\)/);
    expect(await items()).toEqual({
      "ATK-1": `/api/hub-media/${IMG_1}-thumb.webp`,
      "ATK-2": `/api/hub-media/${IMG_2}-thumb.webp`,
      "ATK-3": `/api/hub-media/${IMG_2}-thumb.webp`,
    });
  });

  it("kunci tidak pernah sampai ke browser: proxy /media tidak mengirim Authorization", async () => {
    hub.state.mediaHits.length = 0;
    await app.request(`/api/hub-media/${IMG_2}-thumb.webp`, {}, env);
    expect(hub.state.mediaHits).toEqual([`/media/products/${IMG_2}-thumb.webp`]);
  });
});