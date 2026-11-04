import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { D1DatabaseShim } from "../../scripts/d1-sqlite-shim";
import { catalogRouter } from "./routes/catalog";
import type { Env } from "./env";

/* One photo per catalog item, shown on quotes by line code. */

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function setup() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = path.resolve(import.meta.dirname, "../../migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(path.join(dir, f), "utf8"));
  sqlite.exec(`INSERT INTO users(id, email, name, password_hash, role) VALUES (1, 'm@x', 'M', 'x', 'manager'), (2, 's@x', 'S', 'x', 'rep')`);
  sqlite.exec(`INSERT INTO catalog_items(code, name, uom, cogs, list_price, stock, category) VALUES
    ('A4/80', 'Kertas A4', 'Rim', 38000, 55000, 5, 'ATK'), ('PEN', 'Pulpen', 'Pcs', 2000, 4000, 9, 'ATK')`);
  const db = new D1DatabaseShim(sqlite) as unknown as D1Database;
  return (role: "manager" | "rep") => {
    const a = new Hono<Env>();
    a.use(async (c, next) => {
      c.set("user", { id: role === "manager" ? 1 : 2, email: "x@x", name: "X", role } as never);
      await next();
    });
    a.route("/api/catalog", catalogRouter);
    return (method: string, p: string, body?: unknown) =>
      a.request(p, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json" } }, { DB: db } as never);
  };
}

describe("catalog photos", () => {
  it("upload by code (any case, with a slash), then list, quote lookup and the image itself see it", async () => {
    const as = setup();
    const put = await as("manager")("PUT", "/api/catalog/image?code=a4%2F80", { image: PNG });
    expect(put.status).toBe(200);
    const { image_v } = (await put.json()) as { image_v: number };

    const list = (await (await as("rep")("GET", "/api/catalog")).json()) as { items: { code: string; image_v?: number }[] };
    expect(list.items.find((i) => i.code === "A4/80")?.image_v).toBe(image_v);
    expect(list.items.find((i) => i.code === "PEN")?.image_v).toBeUndefined();

    const which = await (await as("rep")("POST", "/api/catalog/images", { codes: ["a4/80", "PEN", "NOPE"] })).json();
    expect(which).toEqual({ images: { "a4/80": image_v } });

    const img = await as("rep")("GET", "/api/catalog/image?code=A4%2F80&v=1");
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await img.arrayBuffer()).subarray(1, 4).toString()).toBe("PNG");
  });

  it("reps cannot change photos; bad formats, oversize and unknown codes are refused", async () => {
    const as = setup();
    expect((await as("rep")("PUT", "/api/catalog/image?code=PEN", { image: PNG })).status).toBe(403);
    expect((await as("rep")("DELETE", "/api/catalog/image?code=PEN")).status).toBe(403);
    expect((await as("manager")("PUT", "/api/catalog/image?code=PEN", { image: "data:image/svg+xml;base64,PHN2Zz4=" })).status).toBe(400);
    expect((await as("manager")("PUT", "/api/catalog/image?code=PEN", { image: `data:image/png;base64,${"A".repeat(40_000)}` })).status).toBe(400);
    expect((await as("manager")("PUT", "/api/catalog/image?code=NOPE", { image: PNG })).status).toBe(404);
  });

  it("delete removes it", async () => {
    const as = setup();
    await as("manager")("PUT", "/api/catalog/image?code=PEN", { image: PNG });
    expect((await as("manager")("DELETE", "/api/catalog/image?code=PEN")).status).toBe(200);
    expect((await as("rep")("GET", "/api/catalog/image?code=PEN")).status).toBe(404);
  });
});
