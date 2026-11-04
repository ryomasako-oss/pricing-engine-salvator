import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { D1DatabaseShim } from "../../scripts/d1-sqlite-shim";
import { clientsRouter } from "./routes/clients";
import type { Client, DocTemplate } from "../../shared/types";
import type { Env } from "./env";

/** Template per klien (Ryoma, 2026-11-04): saved and read back through the real clients route. */
function setup() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = path.resolve(import.meta.dirname, "../../migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(path.join(dir, f), "utf8"));
  sqlite.exec(`INSERT INTO users(id, email, name, password_hash, role) VALUES (1, 'r@x', 'R', 'x', 'rep')`);
  sqlite.exec(`INSERT INTO clients(id, name, code) VALUES (1, 'PT Mestika', 'MMP')`);
  const a = new Hono<Env>();
  a.use(async (c, next) => {
    c.set("user", { id: 1, email: "r@x", name: "R", role: "rep" } as never);
    await next();
  });
  a.route("/api/clients", clientsRouter);
  const env = { DB: new D1DatabaseShim(sqlite) } as unknown as Env["Bindings"];
  const send = (method: string, body?: unknown, p = "/api/clients/1") =>
    a.request(p, { method, ...(body ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}) }, env);
  const client = async () => {
    const r = await send("GET", undefined, "/api/clients");
    return ((await r.json()) as { clients: Client[] }).clients[0];
  };
  return { sqlite, send, client };
}

const base = { name: "PT Mestika", code: "MMP" };
const tender: DocTemplate = {
  columns: [{ key: "no", label: "No." }, { key: "name", label: "Uraian" }, { key: "qty", label: "Volume" }, { key: "price", label: "Harga" }],
  title: "Surat Penawaran",
  opening: "Dengan hormat,",
  showTotals: false,
};

describe("PUT /api/clients/:id doc_template", () => {
  it("saves a template and GET hands it back as an object", async () => {
    const { send, client, sqlite } = setup();
    const res = await send("PUT", { ...base, doc_template: tender });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { client: Client }).client.doc_template).toEqual(tender);
    expect((await client()).doc_template).toEqual(tender);
    expect(JSON.parse((sqlite.prepare("SELECT doc_template AS t FROM clients WHERE id = 1").get() as { t: string }).t)).toEqual(tender);
  });

  it.each([
    ["a column that is not line data", { columns: [{ key: "cogs", label: "Modal" }, { key: "name", label: "A" }, { key: "price", label: "H" }] }],
    ["a repeated column", { columns: [{ key: "name", label: "A" }, { key: "name", label: "B" }, { key: "price", label: "H" }] }],
    ["two columns with one heading", { columns: [{ key: "name", label: "Harga" }, { key: "price", label: "harga" }] }],
    ["no price column", { columns: [{ key: "name", label: "Uraian" }] }],
    ["an empty heading", { columns: [{ key: "name", label: "  " }, { key: "price", label: "H" }] }],
    ["a heading over 40 characters", { columns: [{ key: "name", label: "x".repeat(41) }, { key: "price", label: "H" }] }],
    ["more columns than exist", { columns: Array.from({ length: 9 }, (_, i) => ({ key: "name", label: `c${i}` })) }],
    ["a title over 80 characters", { title: "x".repeat(81) }],
    ["an opening text over 2000 characters", { opening: "x".repeat(2001) }],
    ["an unknown field", { html: "<b>x</b>" }],
  ])("rejects %s with 400 and keeps the stored template", async (_, bad) => {
    const { send, client } = setup();
    await send("PUT", { ...base, doc_template: tender });
    const res = await send("PUT", { ...base, doc_template: bad });
    expect(res.status).toBe(400);
    expect((await client()).doc_template).toEqual(tender);
  });

  it("an edit that does not send doc_template keeps it; null clears it", async () => {
    const { send, client } = setup();
    await send("PUT", { ...base, doc_template: tender });
    expect((await send("PUT", { ...base, address: "Jakarta" })).status).toBe(200);
    expect((await client()).doc_template).toEqual(tender);
    expect((await send("PUT", { ...base, doc_template: null })).status).toBe(200);
    expect((await client()).doc_template).toBeNull();
  });

  it("a new client can be created with a template; without one it has none", async () => {
    const { send } = setup();
    const res = await send("POST", { name: "PT Tender", doc_template: tender }, "/api/clients");
    expect(res.status).toBe(201);
    expect(((await res.json()) as { client: Client }).client.doc_template).toEqual(tender);
    const plain = await send("POST", { name: "PT Biasa" }, "/api/clients");
    expect(((await plain.json()) as { client: Client }).client.doc_template).toBeNull();
  });
});
