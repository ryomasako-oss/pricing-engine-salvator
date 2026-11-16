import { describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { D1DatabaseShim } from "../../scripts/d1-sqlite-shim";
import {
  createSalesOrderFromQuote,
  getSalesOrder,
  listSalesOrders,
  getSalesOrderEvents,
  cancelSalesOrder,
  applyFmsStateChanged,
} from "./salesOrderService";
import { dispatchSoOutbox, hmacSha256Hex } from "./soDispatcher";
import { salesOrdersRouter } from "./routes/salesOrders";
import { fmsWebhookRouter } from "./routes/fmsWebhook";
import { fmsExportRouter } from "./routes/fmsExport";
import { quotesRouter } from "./routes/quotes";
import type { Env } from "./env";

function freshDb() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = path.resolve(import.meta.dirname, "../../migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(path.join(dir, f), "utf8"));
  }
  sqlite.exec(`INSERT INTO users(id, email, name, password_hash, role) VALUES (1, 'sales@salvator', 'Sarah Sales', 'x', 'rep')`);
  sqlite.exec(`INSERT INTO users(id, email, name, password_hash, role) VALUES (2, 'manager@salvator', 'Budi Manager', 'x', 'manager')`);
  sqlite.exec(`INSERT INTO clients(id, name, code, address, contact_name, contact_phone) VALUES (10, 'PT Mega Pratama', 'CLI-MEGA', 'Sentul Kav 12', 'Budi Santoso', '081234567890')`);
  sqlite.exec(`INSERT INTO catalog_items(id, code, name, uom, cogs, list_price, category) VALUES (1, 'SLV-001', 'Salvator Oxford Black 42', 'Pcs', 250000, 450000, 'Shoes')`);
  
  const quoteItems = JSON.stringify([
    { id: "1", lineNo: 1, code: "SLV-001", name: "Salvator Oxford Black 42", uom: "Pcs", qty: 20, cogs: 250000, rrp: 450000, role: "CORE" },
  ]);
  sqlite.exec(`INSERT INTO quotes(id, number, title, client_id, status, items, regions, assumptions, meta, created_by)
               VALUES (101, 'Q-2026-11-001', 'Proyek Pengadaan Sepatu', 10, 'approved', '${quoteItems}', '[]', '{}', '{}', 1)`);
  sqlite.exec(`INSERT INTO quotes(id, number, title, client_id, status, items, regions, assumptions, meta, created_by)
               VALUES (102, 'Q-2026-11-002', 'Draf Belum Disetujui', 10, 'draft', '${quoteItems}', '[]', '{}', '{}', 1)`);

  return { sqlite, db: new D1DatabaseShim(sqlite) as unknown as D1Database };
}

describe("Sales Order Domain & Service", () => {
  it("creates a Sales Order from an approved quote and enqueues to so_outbox", async () => {
    const { db } = freshDb();
    const { salesOrder, eventId } = await createSalesOrderFromQuote(db, 101, { id: 1, name: "Sarah Sales", role: "rep" });

    expect(salesOrder.orderNo).toMatch(/^SO-\d{4}-\d{4}$/);
    expect(salesOrder.status).toBe("DRAFT");
    expect(salesOrder.clientCode).toBe("CLI-MEGA");
    expect(salesOrder.items.length).toBe(1);
    expect(salesOrder.items[0].sku).toBe("SLV-001");
    expect(salesOrder.items[0].qty).toBe(20);
    expect(salesOrder.totalAmount).toBe(20 * 450000);
    expect(salesOrder.shipping.recipientName).toBe("Budi Santoso");

    const events = await getSalesOrderEvents(db, salesOrder.orderNo);
    expect(events.length).toBe(1);
    expect(events[0].eventType).toBe("sales_order.created");

    // Outbox check
    const outboxRow = await db.prepare("SELECT * FROM so_outbox WHERE event_id = ?").bind(eventId).first<{ status: string; event_type: string }>();
    expect(outboxRow).toBeDefined();
    expect(outboxRow?.status).toBe("PENDING");
    expect(outboxRow?.event_type).toBe("sales_order.created");
  });

  it("rejects creating duplicate SO for the same quote", async () => {
    const { db } = freshDb();
    await createSalesOrderFromQuote(db, 101, { id: 1, name: "Sarah Sales", role: "rep" });
    await expect(
      createSalesOrderFromQuote(db, 101, { id: 1, name: "Sarah Sales", role: "rep" })
    ).rejects.toThrow("sudah pernah dibuat");
  });

  it("rejects creating SO from draft quote when user is rep", async () => {
    const { db } = freshDb();
    await expect(
      createSalesOrderFromQuote(db, 102, { id: 1, name: "Sarah Sales", role: "rep" })
    ).rejects.toThrow("belum disetujui");
  });

  it("cancels an active Sales Order and enqueues sales_order.cancelled event", async () => {
    const { db } = freshDb();
    const { salesOrder } = await createSalesOrderFromQuote(db, 101, { id: 1, name: "Sarah Sales", role: "rep" });

    const cancelled = await cancelSalesOrder(db, salesOrder.id, "Klien membatalkan pesanan", { id: 1, name: "Sarah Sales" });
    expect(cancelled.status).toBe("CANCELLED");
    expect(cancelled.cancelReason).toBe("Klien membatalkan pesanan");
    expect(cancelled.cancelledAt).not.toBeNull();

    const events = await getSalesOrderEvents(db, salesOrder.orderNo);
    expect(events.some((e) => e.eventType === "sales_order.cancelled")).toBe(true);
  });

  it("applies FMS state changed events and enforces inbox idempotency", async () => {
    const { db } = freshDb();
    const { salesOrder } = await createSalesOrderFromQuote(db, 101, { id: 1, name: "Sarah Sales", role: "rep" });

    // State PACKING -> PROCESSING
    const res1 = await applyFmsStateChanged(db, {
      eventId: "evt_test_pack_01",
      eventType: "outbound.state_changed",
      occurredAt: new Date().toISOString(),
      payload: {
        orderNo: salesOrder.orderNo,
        previousState: "READY_TO_PACK",
        newState: "PACKING",
        changedAt: new Date().toISOString(),
        actor: "packer_01",
      },
    });
    expect(res1.applied).toBe(true);
    expect(res1.newStatus).toBe("PROCESSING");

    const soAfterPack = await getSalesOrder(db, salesOrder.id);
    expect(soAfterPack?.status).toBe("PROCESSING");

    // State HANDED_OVER -> SHIPPED with tracking number
    const res2 = await applyFmsStateChanged(db, {
      eventId: "evt_test_handover_02",
      eventType: "outbound.state_changed",
      occurredAt: new Date().toISOString(),
      payload: {
        orderNo: salesOrder.orderNo,
        previousState: "AWAITING_HANDOVER",
        newState: "HANDED_OVER",
        changedAt: new Date().toISOString(),
        trackingNo: "SPX-12345678",
        courierCode: "SPX",
        handoverBatchId: "BATCH-01",
        actor: "spv_01",
      },
    });
    expect(res2.applied).toBe(true);
    expect(res2.newStatus).toBe("SHIPPED");

    const soAfterShip = await getSalesOrder(db, salesOrder.id);
    expect(soAfterShip?.status).toBe("SHIPPED");
    expect(soAfterShip?.trackingNo).toBe("SPX-12345678");
    expect(soAfterShip?.courierCode).toBe("SPX");
    expect(soAfterShip?.shippedAt).not.toBeNull();

    // Idempotency: duplicate event is ignored
    const resDup = await applyFmsStateChanged(db, {
      eventId: "evt_test_handover_02",
      eventType: "outbound.state_changed",
      occurredAt: new Date().toISOString(),
      payload: {
        orderNo: salesOrder.orderNo,
        previousState: "AWAITING_HANDOVER",
        newState: "HANDED_OVER",
        changedAt: new Date().toISOString(),
        actor: "spv_01",
      },
    });
    expect(resDup.applied).toBe(false);
    expect(resDup.duplicate).toBe(true);
  });
});

describe("Outbox Dispatcher", () => {
  it("dispatches pending outbox events to FMS Webhook with HMAC signature", async () => {
    const { db } = freshDb();
    // Enable sales_order_enabled
    await db.prepare("UPDATE settings SET value = '1' WHERE key = 'sales_order_enabled'").run();

    const { salesOrder } = await createSalesOrderFromQuote(db, 101, { id: 1, name: "Sarah Sales", role: "rep" });

    const mockFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const env = {
      DB: db,
      FMS_URL: "http://fms-salvator.local",
      FMS_WEBHOOK_SECRET: "my-secret-key",
    } as any;

    const result = await dispatchSoOutbox(env, { fetchFn: mockFetch });
    expect(result.processed).toBe(1);
    expect(result.delivered).toBe(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const [calledUrl, calledOpts] = mockFetch.mock.calls[0];
    expect(calledUrl).toBe("http://fms-salvator.local/api/webhooks/pricing-engine");
    expect(calledOpts.headers["Content-Type"]).toBe("application/json");
    expect(calledOpts.headers["X-Signature-SHA256"]).toBeDefined();
    expect(calledOpts.headers["X-Event-Type"]).toBe("sales_order.created");

    // Check signature validity
    const calculatedSig = await hmacSha256Hex("my-secret-key", calledOpts.body);
    expect(calledOpts.headers["X-Signature-SHA256"]).toBe(calculatedSig);

    // Verify outbox status updated to DELIVERED
    const row = await db.prepare("SELECT status, delivered_at FROM so_outbox WHERE status = 'DELIVERED'").first<{ status: string; delivered_at: string }>();
    expect(row?.status).toBe("DELIVERED");
    expect(row?.delivered_at).not.toBeNull();
  });
});

describe("Sales Order & Webhook HTTP Routes", () => {
  function createTestApp(db: D1Database) {
    const app = new Hono<Env>();
    app.use(async (c, next) => {
      c.set("user", { id: 1, email: "sales@salvator", name: "Sarah Sales", role: "rep" } as never);
      await next();
    });
    app.route("/api/quotes", quotesRouter);
    app.route("/api/sales-orders", salesOrdersRouter);
    app.route("/api/webhooks/fms", fmsWebhookRouter);
    app.route("/api", fmsExportRouter);
    return app;
  }

  it("handles POST /api/quotes/:id/sales-order and GET /api/sales-orders", async () => {
    const { db } = freshDb();
    const app = createTestApp(db);
    const env = { DB: db, JWT_SECRET: "secret-key-at-least-16-bytes" } as any;

    // POST /api/quotes/101/sales-order
    const resCreate = await app.request("/api/quotes/101/sales-order", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ courierCode: "JNE", serviceLevel: "REG" }),
    }, env);

    expect(resCreate.status).toBe(201);
    const createJson = (await resCreate.json()) as any;
    expect(createJson.ok).toBe(true);
    expect(createJson.salesOrder.orderNo).toMatch(/^SO-/);
    expect(createJson.salesOrder.shipping.courierCode).toBe("JNE");

    // GET /api/sales-orders
    const resList = await app.request("/api/sales-orders", { method: "GET" }, env);
    expect(resList.status).toBe(200);
    const listJson = (await resList.json()) as any;
    expect(listJson.total).toBe(1);
    expect(listJson.items[0].orderNo).toBe(createJson.salesOrder.orderNo);

    // GET /api/sales-orders/:id
    const resGet = await app.request(`/api/sales-orders/${createJson.salesOrder.id}`, { method: "GET" }, env);
    expect(resGet.status).toBe(200);
    const getJson = (await resGet.json()) as any;
    expect(getJson.salesOrder.id).toBe(createJson.salesOrder.id);
    expect(getJson.events.length).toBeGreaterThanOrEqual(1);
  });

  it("handles POST /api/webhooks/fms with valid signature", async () => {
    const { db } = freshDb();
    const app = createTestApp(db);
    const secret = "fms-secret-123456";
    const env = { DB: db, FMS_WEBHOOK_SECRET: secret } as any;

    // Create SO first
    await createSalesOrderFromQuote(db, 101, { id: 1, name: "Sarah Sales", role: "rep" });
    const so = (await listSalesOrders(db)).items[0];

    const payload = {
      eventId: "evt_webhook_test_01",
      eventType: "outbound.state_changed",
      occurredAt: new Date().toISOString(),
      payload: {
        orderNo: so.orderNo,
        previousState: "READY_TO_PACK",
        newState: "PACKING",
        changedAt: new Date().toISOString(),
        actor: "fms_packer",
      },
    };
    const rawBody = JSON.stringify(payload);
    const signature = await hmacSha256Hex(secret, rawBody);

    const res = await app.request("/api/webhooks/fms", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Signature-SHA256": signature,
        "X-Timestamp": new Date().toISOString(),
        "X-Event-Id": payload.eventId,
        "X-Event-Type": payload.eventType,
      },
      body: rawBody,
    }, env);

    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.ok).toBe(true);
    expect(json.applied).toBe(true);
    expect(json.newStatus).toBe("PROCESSING");
  });

  it("handles GET /api/catalog/export-fms and GET /api/clients/export-fms", async () => {
    const { db } = freshDb();
    const app = createTestApp(db);
    const secret = "sync-secret-123";
    const env = { DB: db, FMS_WEBHOOK_SECRET: secret } as any;

    // GET /api/catalog/export-fms with Bearer token
    const resCat = await app.request("/api/catalog/export-fms", {
      method: "GET",
      headers: { Authorization: `Bearer ${secret}` },
    }, env);

    expect(resCat.status).toBe(200);
    const catJson = (await resCat.json()) as any;
    expect(catJson.ok).toBe(true);
    expect(catJson.products.length).toBeGreaterThanOrEqual(1);
    expect(catJson.products[0].sku).toBe("SLV-001");

    // GET /api/clients/export-fms with Bearer token
    const resCli = await app.request("/api/clients/export-fms", {
      method: "GET",
      headers: { Authorization: `Bearer ${secret}` },
    }, env);

    expect(resCli.status).toBe(200);
    const cliJson = (await resCli.json()) as any;
    expect(cliJson.ok).toBe(true);
    expect(cliJson.clients.length).toBeGreaterThanOrEqual(1);
    expect(cliJson.clients[0].clientCode).toBe("CLI-MEGA");
  });
});
