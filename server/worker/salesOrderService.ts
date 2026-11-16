/* ============================================================
   Pricing Engine — Sales Order Service
   Manages Sales Order lifecycle, D1 transactions, and outbox.
   ============================================================ */

import { all, get, stmt, batch } from "../db.d1";
import {
  type SalesOrder,
  type SalesOrderEvent,
  type SalesOrderItem,
  type SalesOrderShipping,
  type SalesOrderStatus,
  canCancelSo,
  formatSalesOrderNo,
  mapFmsStateToSoStatus,
} from "../../shared/salesOrder";
import type { OutboundStateChangedEvent } from "../../shared/fmsContract";
import type { QuoteItem } from "../../shared/types";

interface DbQuoteRow {
  id: number;
  number: string;
  client_id: number | null;
  status: string;
  items: string;
  created_by: number;
}

interface DbClientRow {
  id: number;
  name: string;
  code: string;
  address: string;
  contact_name: string;
  contact_phone: string;
}

interface DbSoRow {
  id: string;
  order_no: string;
  quote_id: number;
  quote_number: string;
  client_code: string;
  client_name: string;
  status: SalesOrderStatus;
  items_json: string;
  shipping_json: string;
  tracking_no: string | null;
  courier_code: string | null;
  total_amount: number;
  created_by: number;
  created_at: string;
  updated_at: string;
  confirmed_at: string | null;
  shipped_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
}

function parseSoRow(row: DbSoRow): SalesOrder {
  return {
    id: row.id,
    orderNo: row.order_no,
    quoteId: row.quote_id,
    quoteNumber: row.quote_number,
    clientCode: row.client_code,
    clientName: row.client_name,
    status: row.status,
    items: JSON.parse(row.items_json || "[]") as SalesOrderItem[],
    shipping: JSON.parse(row.shipping_json || "{}") as SalesOrderShipping,
    trackingNo: row.tracking_no,
    courierCode: row.courier_code,
    totalAmount: row.total_amount,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    confirmedAt: row.confirmed_at,
    shippedAt: row.shipped_at,
    cancelledAt: row.cancelled_at,
    cancelReason: row.cancel_reason,
  };
}

export async function getNextOrderNo(d1: D1Database, now = new Date()): Promise<string> {
  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const prefix = `SO-${yy}${mm}-`;

  const latest = await get<{ order_no: string }>(
    d1,
    `SELECT order_no FROM sales_orders WHERE order_no LIKE ? ORDER BY order_no DESC LIMIT 1`,
    `${prefix}%`,
  );

  let seq = 1;
  if (latest?.order_no) {
    const parts = latest.order_no.split("-");
    const lastNum = parseInt(parts[parts.length - 1], 10);
    if (!Number.isNaN(lastNum)) {
      seq = lastNum + 1;
    }
  }
  return formatSalesOrderNo(seq, now);
}

export async function createSalesOrderFromQuote(
  d1: D1Database,
  quoteId: number,
  user: { id: number; name: string; role: string },
  shippingOverride?: Partial<SalesOrderShipping>,
): Promise<{ salesOrder: SalesOrder; eventId: string }> {
  const quote = await get<DbQuoteRow>(
    d1,
    `SELECT id, number, client_id, status, items, created_by FROM quotes WHERE id = ?`,
    quoteId,
  );
  if (!quote) {
    throw new Error(`Quotation dengan ID ${quoteId} tidak ditemukan.`);
  }

  // Hanya status yang sudah disetujui / dimenangkan / dikirim yang boleh dibuatkan SO
  const allowedStatuses = ["approved", "won", "sent", "acc"];
  const isPrivileged = user.role === "manager" || user.role === "admin";
  if (!allowedStatuses.includes(quote.status.toLowerCase()) && !isPrivileged) {
    throw new Error(
      `Quotation berstatus '${quote.status}' belum disetujui. SO hanya dapat dibuat dari quotation yang disetujui.`,
    );
  }

  // Cek apakah sudah pernah dibuat SO aktif untuk quote ini
  const existingSo = await get<{ id: string; order_no: string }>(
    d1,
    `SELECT id, order_no FROM sales_orders WHERE quote_id = ? AND status != 'CANCELLED' LIMIT 1`,
    quoteId,
  );
  if (existingSo) {
    throw new Error(`Sales Order (${existingSo.order_no}) sudah pernah dibuat untuk quotation ini.`);
  }

  let client: DbClientRow | undefined;
  if (quote.client_id) {
    client = await get<DbClientRow>(
      d1,
      `SELECT id, name, code, address, contact_name, contact_phone FROM clients WHERE id = ?`,
      quote.client_id,
    );
  }

  const clientCode = client?.code || `CLI-${quote.client_id || "UMUM"}`;
  const clientName = client?.name || "Klien Umum";

  // Parse item dari quotation
  const rawItems = (JSON.parse(quote.items || "[]") as QuoteItem[]).filter(
    (item) => !item.unmatched && item.qty > 0,
  );
  if (rawItems.length === 0) {
    throw new Error("Quotation tidak memiliki item valid untuk diterbitkan ke Sales Order.");
  }

  const soItems: SalesOrderItem[] = rawItems.map((item) => {
    const price = item.manualPrice?.[0] ?? item.rrp ?? 0;
    const cogs = item.cogs ?? 0;
    return {
      sku: item.code || `ITEM-${item.id}`,
      name: item.name,
      qty: item.qty,
      uom: item.uom || "Pcs",
      price,
      cogs,
      subtotal: price * item.qty,
      notes: item.notes,
    };
  });

  const totalAmount = soItems.reduce((acc, it) => acc + it.subtotal, 0);

  // Siapkan data pengiriman default dari master client
  const defaultShipping: SalesOrderShipping = {
    recipientName: shippingOverride?.recipientName || client?.contact_name || clientName,
    phone: shippingOverride?.phone || client?.contact_phone || "081200000000",
    address: shippingOverride?.address || client?.address || "Alamat Klien",
    city: shippingOverride?.city || "Jakarta",
    postalCode: shippingOverride?.postalCode || "",
    courierCode: shippingOverride?.courierCode || "SPX",
    serviceLevel: shippingOverride?.serviceLevel || "STANDARD",
    notes: shippingOverride?.notes || "",
  };

  const now = new Date();
  const nowIso = now.toISOString();
  const soId = `so_${crypto.randomUUID().replace(/-/g, "")}`;
  const orderNo = await getNextOrderNo(d1, now);
  const eventId = `evt_so_create_${orderNo}_${now.getTime()}`;

  const soCreatedPayload = {
    orderNo,
    quoteId: quote.number,
    clientCode,
    clientName,
    orderedAt: nowIso,
    items: soItems.map((it) => ({
      sku: it.sku,
      name: it.name,
      qty: it.qty,
      uom: it.uom,
      notes: it.notes,
    })),
    shipping: defaultShipping,
    metadata: {
      salesPerson: user.name,
      quoteId: quote.id,
      quoteNumber: quote.number,
    },
  };

  const soOutboxBody = {
    eventId,
    eventType: "sales_order.created",
    occurredAt: nowIso,
    payload: soCreatedPayload,
  };

  const statements = [
    stmt(
      d1,
      `INSERT INTO sales_orders (
         id, order_no, quote_id, quote_number, client_code, client_name,
         status, items_json, shipping_json, total_amount, created_by,
         created_at, updated_at, confirmed_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?, ?, ?, ?)`,
      soId,
      orderNo,
      quote.id,
      quote.number,
      clientCode,
      clientName,
      JSON.stringify(soItems),
      JSON.stringify(defaultShipping),
      totalAmount,
      user.id,
      nowIso,
      nowIso,
      nowIso,
    ),
    stmt(
      d1,
      `INSERT INTO sales_order_events (id, order_no, event_type, payload_json, actor, created_at)
       VALUES (?, ?, 'sales_order.created', ?, ?, ?)`,
      `evt_${crypto.randomUUID().replace(/-/g, "")}`,
      orderNo,
      JSON.stringify(soCreatedPayload),
      user.name,
      nowIso,
    ),
    stmt(
      d1,
      `INSERT INTO so_outbox (id, event_id, event_type, payload_json, status, created_at, next_attempt_at)
       VALUES (?, ?, 'sales_order.created', ?, 'PENDING', ?, ?)`,
      `out_${crypto.randomUUID().replace(/-/g, "")}`,
      eventId,
      JSON.stringify(soOutboxBody),
      nowIso,
      nowIso,
    ),
  ];

  await batch(d1, statements);

  const createdSo = await getSalesOrder(d1, soId);
  if (!createdSo) {
    throw new Error("Gagal mengambil Sales Order yang baru dibuat.");
  }

  return { salesOrder: createdSo, eventId };
}

export async function getSalesOrder(d1: D1Database, idOrOrderNo: string): Promise<SalesOrder | null> {
  const row = await get<DbSoRow>(
    d1,
    `SELECT * FROM sales_orders WHERE id = ? OR order_no = ? LIMIT 1`,
    idOrOrderNo,
    idOrOrderNo,
  );
  return row ? parseSoRow(row) : null;
}

export async function listSalesOrders(
  d1: D1Database,
  options: {
    status?: string;
    clientCode?: string;
    q?: string;
    limit?: number;
    offset?: number;
  } = {},
): Promise<{ items: SalesOrder[]; total: number }> {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (options.status) {
    conditions.push("status = ?");
    params.push(options.status.toUpperCase());
  }

  if (options.clientCode) {
    conditions.push("client_code = ?");
    params.push(options.clientCode);
  }

  if (options.q) {
    conditions.push("(order_no LIKE ? OR quote_number LIKE ? OR client_name LIKE ?)");
    const query = `%${options.q}%`;
    params.push(query, query, query);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const countRow = await get<{ count: number }>(d1, `SELECT COUNT(*) as count FROM sales_orders ${whereClause}`, ...params);
  const total = countRow?.count ?? 0;

  const limit = options.limit ?? 50;
  const offset = options.offset ?? 0;

  const rows = await all<DbSoRow>(
    d1,
    `SELECT * FROM sales_orders ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    ...params,
    limit,
    offset,
  );

  return {
    items: rows.map(parseSoRow),
    total,
  };
}

export async function getSalesOrderEvents(d1: D1Database, orderNo: string): Promise<SalesOrderEvent[]> {
  const rows = await all<{
    id: string;
    order_no: string;
    event_type: string;
    payload_json: string;
    actor: string;
    created_at: string;
  }>(d1, `SELECT * FROM sales_order_events WHERE order_no = ? ORDER BY created_at ASC`, orderNo);

  return rows.map((r) => ({
    id: r.id,
    orderNo: r.order_no,
    eventType: r.event_type,
    payload: JSON.parse(r.payload_json || "{}"),
    actor: r.actor,
    createdAt: r.created_at,
  }));
}

export async function cancelSalesOrder(
  d1: D1Database,
  idOrOrderNo: string,
  reason: string,
  user: { id: number; name: string },
): Promise<SalesOrder> {
  const so = await getSalesOrder(d1, idOrOrderNo);
  if (!so) {
    throw new Error(`Sales Order '${idOrOrderNo}' tidak ditemukan.`);
  }

  if (!canCancelSo(so.status)) {
    throw new Error(
      `Sales Order '${so.orderNo}' tidak dapat dibatalkan karena sudah dalam status '${so.status}'.`,
    );
  }

  const now = new Date();
  const nowIso = now.toISOString();
  const eventId = `evt_so_cancel_${so.orderNo}_${now.getTime()}`;

  const cancelPayload = {
    orderNo: so.orderNo,
    reason,
    cancelledAt: nowIso,
    actor: user.name,
  };

  const cancelOutboxBody = {
    eventId,
    eventType: "sales_order.cancelled",
    occurredAt: nowIso,
    payload: cancelPayload,
  };

  const statements = [
    stmt(
      d1,
      `UPDATE sales_orders
       SET status = 'CANCELLED',
           cancel_reason = ?,
           cancelled_at = ?,
           updated_at = ?
       WHERE id = ?`,
      reason,
      nowIso,
      nowIso,
      so.id,
    ),
    stmt(
      d1,
      `INSERT INTO sales_order_events (id, order_no, event_type, payload_json, actor, created_at)
       VALUES (?, ?, 'sales_order.cancelled', ?, ?, ?)`,
      `evt_${crypto.randomUUID().replace(/-/g, "")}`,
      so.orderNo,
      JSON.stringify(cancelPayload),
      user.name,
      nowIso,
    ),
    stmt(
      d1,
      `INSERT INTO so_outbox (id, event_id, event_type, payload_json, status, created_at, next_attempt_at)
       VALUES (?, ?, 'sales_order.cancelled', ?, 'PENDING', ?, ?)`,
      `out_${crypto.randomUUID().replace(/-/g, "")}`,
      eventId,
      JSON.stringify(cancelOutboxBody),
      nowIso,
      nowIso,
    ),
  ];

  await batch(d1, statements);

  const updated = await getSalesOrder(d1, so.id);
  return updated!;
}

export async function applyFmsStateChanged(
  d1: D1Database,
  event: OutboundStateChangedEvent,
): Promise<{ applied: boolean; duplicate?: boolean; previousStatus?: string; newStatus?: string }> {
  // 1. Cek idempotensi inbox
  const existingInbox = await get<{ id: string }>(
    d1,
    `SELECT id FROM fms_inbox WHERE event_id = ? LIMIT 1`,
    event.eventId,
  );
  if (existingInbox) {
    return { applied: false, duplicate: true };
  }

  const so = await getSalesOrder(d1, event.payload.orderNo);
  const nowIso = new Date().toISOString();

  // Jika SO tidak ditemukan di PE, catat di inbox dan kembalikan applied: false
  if (!so) {
    await stmt(
      d1,
      `INSERT INTO fms_inbox (id, event_id, event_type, payload_json, processed_at) VALUES (?, ?, ?, ?, ?)`,
      `in_${crypto.randomUUID().replace(/-/g, "")}`,
      event.eventId,
      event.eventType,
      JSON.stringify(event.payload),
      nowIso,
    ).run();
    return { applied: false };
  }

  const mappedStatus = mapFmsStateToSoStatus(event.payload.newState);
  const nextStatus = mappedStatus ?? so.status;

  const statements = [
    stmt(
      d1,
      `INSERT INTO fms_inbox (id, event_id, event_type, payload_json, processed_at) VALUES (?, ?, ?, ?, ?)`,
      `in_${crypto.randomUUID().replace(/-/g, "")}`,
      event.eventId,
      event.eventType,
      JSON.stringify(event.payload),
      nowIso,
    ),
    stmt(
      d1,
      `INSERT INTO sales_order_events (id, order_no, event_type, payload_json, actor, created_at)
       VALUES (?, ?, 'outbound.state_changed', ?, ?, ?)`,
      `evt_${crypto.randomUUID().replace(/-/g, "")}`,
      so.orderNo,
      JSON.stringify(event.payload),
      event.payload.actor,
      event.occurredAt || nowIso,
    ),
    stmt(
      d1,
      `UPDATE sales_orders
       SET status = ?,
           tracking_no = COALESCE(?, tracking_no),
           courier_code = COALESCE(?, courier_code),
           shipped_at = CASE WHEN ? = 'HANDED_OVER' THEN COALESCE(shipped_at, ?) ELSE shipped_at END,
           updated_at = ?
       WHERE id = ?`,
      nextStatus,
      event.payload.trackingNo ?? null,
      event.payload.courierCode ?? null,
      event.payload.newState,
      event.occurredAt || nowIso,
      nowIso,
      so.id,
    ),
  ];

  await batch(d1, statements);

  return {
    applied: true,
    previousStatus: so.status,
    newStatus: nextStatus,
  };
}
