import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { D1DatabaseShim } from "../../../scripts/d1-sqlite-shim";
import { accurateRouter } from "../routes/accurate";
import { fakeAccurate } from "./testing";
import type { Env } from "../env";

function app(fake: ReturnType<typeof fakeAccurate>) {
  const sqlite = new DatabaseSync(":memory:");
  const dir = path.resolve(import.meta.dirname, "../../../migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(path.join(dir, f), "utf8"));
  vi.stubGlobal("fetch", fake.impl);
  const a = new Hono<Env>();
  a.use(async (c, next) => {
    c.set("user", { id: 1, email: "a@x", name: "A", role: "admin" } as never);
    await next();
  });
  a.route("/api/accurate", accurateRouter);
  const env = { DB: new D1DatabaseShim(sqlite), ACCURATE_TOKEN_PT: "aat.test", ACCURATE_SIGNATURE_SECRET: "s" } as unknown as Env["Bindings"];
  return (q: string) => a.request(`/api/accurate/probe?entity=PT${q}`, {}, env);
}

afterEach(() => vi.unstubAllGlobals());

const INVOICE = {
  id: 9001, number: "SI.2026.10.00042", transDate: "16/10/2026", lastUpdate: "16/10/2026 15:00:00",
  customer: { customerNo: "C-0007", name: "CGV INDONESIA" },
  detailItem: [{ id: 1, item: { no: "100799" }, detailName: "ISI PEN SARASA BIRU", itemUnit: { name: "PAK" }, quantity: 2, unitPrice: 157_200 }],
};

describe("GET /api/accurate/probe — sales invoices (2026-10-17)", () => {
  it("leaves sales invoices out unless asked", async () => {
    const probe = app(fakeAccurate({ items: [], stock: {} }));
    const body = (await (await probe("")).json()) as any;
    expect(body.sales).toBeNull();
  });

  it("shows one invoice with its lines and whether the lastUpdate filter narrows the list", async () => {
    const probe = app(fakeAccurate({ items: [], stock: {}, salesInvoices: [{ ...INVOICE, lastUpdate: "01/01/2025 08:00:00", id: 1, number: "SI.OLD" }, INVOICE] }));
    const res = await probe("&sales=1");
    expect(res.status).toBe(200);
    const { sales } = (await res.json()) as any;
    expect(sales.filterCheck).toMatchObject({ all: 2, updatedRecently: expect.any(Number) });
    expect(sales.detail.d.detailItem[0]).toMatchObject({ detailName: "ISI PEN SARASA BIRU", item: { no: "100799" } });
    const byNumber = (await (await probe("&invoice=SI.OLD")).json()) as any;
    expect(byNumber.sales.detail.d.number).toBe("SI.OLD");
  });

  it("reports a token without the sales-invoice scope instead of failing the whole probe", async () => {
    const probe = app(fakeAccurate({ items: [], stock: {} }));
    const res = await probe("&sales=1");
    expect(res.status).toBe(200);
    const { sales, warehouses } = (await res.json()) as any;
    expect(warehouses).toBeTruthy();
    expect(sales.list.error).toMatch(/sales_invoice_view/);
  });
});
