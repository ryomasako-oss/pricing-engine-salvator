/* ============================================================
   Pricing Engine — Sales Order API Routes
   ============================================================ */

import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { requireAuth } from "../auth";
import {
  createSalesOrderFromQuote,
  getSalesOrder,
  listSalesOrders,
  getSalesOrderEvents,
  cancelSalesOrder,
} from "../salesOrderService";

export const salesOrdersRouter = new Hono<Env>();

salesOrdersRouter.use(requireAuth);

const CreateSoSchema = z.object({
  recipientName: z.string().optional(),
  phone: z.string().optional(),
  address: z.string().optional(),
  city: z.string().optional(),
  postalCode: z.string().optional(),
  courierCode: z.string().optional(),
  serviceLevel: z.string().optional(),
  notes: z.string().optional(),
});

// POST /api/quotes/:id/sales-order
salesOrdersRouter.post("/from-quote/:id", async (c) => {
  const quoteId = parseInt(c.req.param("id"), 10);
  if (Number.isNaN(quoteId)) {
    return c.json({ error: "ID Quotation tidak valid." }, 400);
  }

  const user = c.get("user")!;
  let body = {};
  try {
    body = await c.req.json();
  } catch {
    // Body is optional
  }

  const parsed = CreateSoSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Payload pengiriman tidak valid.", details: parsed.error.issues }, 400);
  }

  try {
    const result = await createSalesOrderFromQuote(c.env.DB, quoteId, user, parsed.data);
    return c.json({ ok: true, salesOrder: result.salesOrder, eventId: result.eventId }, 201);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 400);
  }
});

// GET /api/sales-orders
salesOrdersRouter.get("/", async (c) => {
  const status = c.req.query("status");
  const clientCode = c.req.query("clientCode");
  const q = c.req.query("q");
  const limit = c.req.query("limit") ? parseInt(c.req.query("limit")!, 10) : 50;
  const offset = c.req.query("offset") ? parseInt(c.req.query("offset")!, 10) : 0;

  const result = await listSalesOrders(c.env.DB, {
    status,
    clientCode,
    q,
    limit,
    offset,
  });

  return c.json(result);
});

// GET /api/sales-orders/:id
salesOrdersRouter.get("/:id", async (c) => {
  const idOrOrderNo = c.req.param("id");
  const so = await getSalesOrder(c.env.DB, idOrOrderNo);
  if (!so) {
    return c.json({ error: "Sales Order tidak ditemukan." }, 404);
  }

  const events = await getSalesOrderEvents(c.env.DB, so.orderNo);
  return c.json({ salesOrder: so, events });
});

// POST /api/sales-orders/:id/cancel
const CancelSoSchema = z.object({
  reason: z.string().min(1, "Alasan pembatalan wajib diisi."),
});

salesOrdersRouter.post("/:id/cancel", async (c) => {
  const idOrOrderNo = c.req.param("id");
  const user = c.get("user")!;

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Format request body tidak valid (JSON diharapkan)." }, 400);
  }

  const parsed = CancelSoSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues[0]?.message || "Payload tidak valid." }, 400);
  }

  try {
    const updated = await cancelSalesOrder(c.env.DB, idOrOrderNo, parsed.data.reason, user);
    return c.json({ ok: true, salesOrder: updated });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 400);
  }
});
