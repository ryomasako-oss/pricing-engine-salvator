/* ============================================================
   Sales Order: baris dari quotation, amplop event ke FMS, linimasa,
   dan penerapan status gudang dari FMS (docs/integrasi-pe-fms.md).
   Route ada di routes/quotes.ts (Jadikan SO), routes/salesOrders.ts
   (daftar, detail, batal, kirim ulang), routes/fmsIntegration.ts (FMS).
   ============================================================ */

import { all, batch, get, stmt } from "../db.d1";
import { computeEngine } from "../../shared/engine";
import { normalizeCode } from "../../shared/duplicates";
import { catalogListsByKeys } from "./quoteService";
import {
  CONTRACT_VERSION,
  isoSeconds,
  type Ack,
  type OutboundStateChanged,
  type PeEventType,
  type SalesOrderCancel,
  type SalesOrderCreated,
  type SoLine,
} from "../../shared/fmsContract";
import { FULFILLMENT_LABEL, fulfillmentFromFms, type FulfillmentState, type SalesOrderStatus, type SyncState } from "../../shared/fmsState";
import type { Quote } from "../../shared/types";

/* ---------------- saklar ---------------- */

export const SO_FLAG = "sales_order_enabled";
export const SO_DISABLED = "Fitur Sales Order belum dinyalakan.";

/** On only when the settings row says '1'; a missing row is off. */
export async function salesOrderEnabled(db: D1Database): Promise<boolean> {
  const row = await get<{ value: string }>(db, "SELECT value FROM settings WHERE key = ?", SO_FLAG);
  return row?.value === "1";
}

/* ---------------- baris SO dari quotation ---------------- */

/** A line as stored on the SO: the contract line plus the selected scenario's price (never COGS). */
export interface SoSnapshotLine extends SoLine {
  price: number;
  amount: number;
}

export interface ExcludedLine {
  lineNo: number;
  sku: string;
  name: string;
  uom: string;
  qty: number;
  reason: string;
}

const HOLD_REASON: Record<string, string> = {
  cogs: "COGS menunggu dicek manajer",
  sales: "Ditolak di cek harga sales",
  new_item: "Barang baru belum dibuat di Accurate",
  new_item_cancelled: "Barang baru dibatalkan",
  unmatched: "Belum cocok dengan barang katalog",
};

/**
 * The quote's lines priced at its selected scenario with the same engine the
 * quote screen and its exports use (computeEngine(...).prices[scenario]).
 * Held and unmatched lines stay out; `quote` must come from findQuote so the
 * holds are applied.
 */
export async function soLinesFor(db: D1Database, quote: Quote): Promise<{ lines: SoSnapshotLine[]; excluded: ExcludedLine[]; total: number }> {
  const engine = computeEngine(quote.assumptions, quote.items, quote.regions);
  const k = quote.scenario;
  const catalog = await catalogListsByKeys(db, engine.rows.map((r) => r.code).filter((code) => code.trim()));
  const lines: SoSnapshotLine[] = [];
  const excluded: ExcludedLine[] = [];
  for (const r of engine.rows) {
    const reason = r.unmatched
      ? HOLD_REASON.unmatched
      : r.held
        ? HOLD_REASON[r.holdReason ?? "cogs"] ?? HOLD_REASON.cogs
        : !r.code.trim()
          ? "Tanpa kode barang"
          : !(r.qty > 0)
            ? "Qty kosong"
            : !Number.isInteger(r.qty)
              ? "Qty pecahan tidak bisa dikirim ke gudang"
              : null;
    if (reason) {
      excluded.push({ lineNo: r.lineNo, sku: r.code, name: r.name, uom: r.uom, qty: r.qty, reason });
      continue;
    }
    const rows = catalog.get(normalizeCode(r.code)) ?? [];
    const item = rows.find((c) => c.code === r.code) ?? rows[0];
    const same = item && item.uom.toLowerCase() === r.uom.toLowerCase();
    const factor = same ? 1 : item?.units?.find((u) => u.uom.toLowerCase() === r.uom.toLowerCase())?.factor;
    const price = r.prices[k];
    lines.push({
      lineNo: r.lineNo,
      sku: r.code,
      name: r.name,
      uom: r.uom,
      qty: r.qty,
      baseUom: item ? item.uom : null,
      baseQty: factor ? r.qty * factor : null,
      price,
      amount: r.qty * price,
    });
  }
  return { lines, excluded, total: lines.reduce((s, l) => s + l.amount, 0) };
}

/** The contract line (what FMS gets): no price, no amount. */
export const contractLine = ({ price: _p, amount: _a, ...line }: SoSnapshotLine): SoLine => line;

/* ---------------- statements ---------------- */

const SO_ID = "(SELECT id FROM sales_orders WHERE number = ?)";

export interface Envelope<T extends PeEventType, P> {
  v: typeof CONTRACT_VERSION;
  eventId: string;
  sequence: number;
  type: T;
  occurredAt: string;
  payload: P;
}

export function envelope<T extends PeEventType, P>(type: T, payload: P, now = new Date()): Envelope<T, P> {
  // sequence is filled from the outbox id when the row is written (outboxStmts).
  return { v: CONTRACT_VERSION, eventId: crypto.randomUUID(), sequence: 0, type, occurredAt: isoSeconds(now), payload };
}

export function outboxStmts(db: D1Database, soNumber: string, event: Envelope<PeEventType, SalesOrderCreated | SalesOrderCancel>): D1PreparedStatement[] {
  return [
    stmt(
      db,
      `INSERT INTO so_outbox(event_id, sales_order_id, type, body) VALUES (?, ${SO_ID}, ?, ?)`,
      event.eventId, soNumber, event.type, JSON.stringify(event),
    ),
    // The outbox id rises per sender, which is what `sequence` must do; it exists only after the INSERT.
    stmt(db, "UPDATE so_outbox SET body = json_set(body, '$.sequence', id) WHERE event_id = ?", event.eventId),
  ];
}

export const timelineStmt = (db: D1Database, soNumber: string, kind: string, detail?: unknown) =>
  stmt(
    db,
    `INSERT INTO sales_order_events(sales_order_id, kind, detail) VALUES (${SO_ID}, ?, ?)`,
    soNumber, kind, detail === undefined ? null : JSON.stringify(detail),
  );

export const auditStmt = (db: D1Database, actorId: number | null, soNumber: string, action: string, detail: unknown = "") =>
  stmt(
    db,
    `INSERT INTO audit_log(actor_id, entity, entity_id, action, detail) VALUES (?, 'sales_order', ${SO_ID}, ?, ?)`,
    actorId, soNumber, action, typeof detail === "string" ? detail : JSON.stringify(detail),
  );

/** First statement of a batch: raises (aborting the batch) unless the SO is still in `status`. */
export const soStatusGuard = (db: D1Database, id: number, status: SalesOrderStatus) =>
  stmt(
    db,
    `SELECT CASE WHEN EXISTS (SELECT 1 FROM sales_orders WHERE id = ? AND status = ?) THEN 1 ELSE json('sales order moved') END AS ok`,
    id, status,
  );

/* ---------------- baca ---------------- */

export interface SalesOrderRow {
  id: number;
  number: string;
  quote_id: number;
  quote_number: string;
  quote_rev_no: number;
  client_id: number | null;
  client_name: string | null;
  status: SalesOrderStatus;
  sync_state: SyncState;
  sync_error: string | null;
  fulfillment_state: FulfillmentState | null;
  fulfillment_reason: string | null;
  fms_outbound_ref: string | null;
  last_fms_sequence: number;
  customer_po_number: string | null;
  ship_to_name: string;
  ship_to_phone: string | null;
  ship_to_address: string;
  requested_date: string | null;
  note: string | null;
  lines: string;
  total_value: number;
  created_by: number;
  created_by_name: string | null;
  created_at: string;
  updated_at: string;
}

const SELECT_SO = `
  SELECT so.*, q.number AS quote_number, c.name AS client_name, u.name AS created_by_name
    FROM sales_orders so
    JOIN quotes q ON q.id = so.quote_id
    LEFT JOIN clients c ON c.id = so.client_id
    LEFT JOIN users u ON u.id = so.created_by`;

export const findSalesOrder = (db: D1Database, id: number) => get<SalesOrderRow>(db, `${SELECT_SO} WHERE so.id = ?`, id);

export const activeSalesOrderFor = (db: D1Database, quoteId: number) =>
  get<{ id: number; number: string; status: SalesOrderStatus }>(
    db,
    "SELECT id, number, status FROM sales_orders WHERE quote_id = ? AND status <> 'cancelled'",
    quoteId,
  );

export function listSalesOrders(db: D1Database, f: { status?: string; q?: string }) {
  const where: string[] = [];
  const params: string[] = [];
  if (f.status) {
    where.push("so.status = ?");
    params.push(f.status);
  }
  if (f.q) {
    where.push("(so.number LIKE ? ESCAPE '\\' OR q.number LIKE ? ESCAPE '\\' OR c.name LIKE ? ESCAPE '\\')");
    const like = `%${f.q.replace(/[\\%_]/g, "\\$&")}%`;
    params.push(like, like, like);
  }
  return all<SalesOrderRow>(
    db,
    `${SELECT_SO} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY so.id DESC LIMIT 200`,
    ...params,
  );
}

export const salesOrderEvents = (db: D1Database, id: number) =>
  all<{ id: number; kind: string; detail: string | null; created_at: string }>(
    db,
    "SELECT id, kind, detail, created_at FROM sales_order_events WHERE sales_order_id = ? ORDER BY id",
    id,
  );

/* ---------------- event dari FMS ---------------- */

export type FmsEventResult = { status: 200; ack: Ack } | { status: 422; error: string };

/**
 * Applies one outbound.state_changed (already signature- and schema-checked).
 * Idempotent per eventId; an event older than the last one applied for that
 * SO is acknowledged and ignored.
 */
export async function applyFmsEvent(
  db: D1Database,
  event: { eventId: string; sequence: number; payload: OutboundStateChanged },
): Promise<FmsEventResult> {
  const seen = await get<{ result: string | null }>(db, "SELECT result FROM fms_inbox WHERE event_id = ?", event.eventId);
  if (seen) return { status: 200, ack: duplicateAck(seen.result) };

  const p = event.payload;
  const so = await get<{ id: number; number: string; last_fms_sequence: number }>(
    db,
    "SELECT id, number, last_fms_sequence FROM sales_orders WHERE number = ?",
    p.soNumber,
  );
  if (!so) return { status: 422, error: `Sales Order ${p.soNumber} tidak dikenal.` };

  const stale: Ack = { received: true, duplicate: false, applied: false, reason: "event lama" };
  if (event.sequence <= so.last_fms_sequence) return { status: 200, ack: await recordOnly(db, event.eventId, stale) };

  const state = fulfillmentFromFms(p.state);
  const applied: Ack = { received: true, duplicate: false, applied: true };
  const detail = { prevState: p.prevState, state: p.state, label: FULFILLMENT_LABEL[state], reason: p.reason, outboundRef: p.outboundRef, courier: p.courier, tracking: p.tracking, manifestNo: p.manifestNo, sequence: event.sequence };
  try {
    await batch(db, [
      stmt(db, "INSERT INTO fms_inbox(event_id, result) VALUES (?, ?)", event.eventId, JSON.stringify(applied)),
      stmt(
        db,
        `SELECT CASE WHEN EXISTS (SELECT 1 FROM sales_orders WHERE id = ? AND last_fms_sequence < ?) THEN 1 ELSE json('stale event') END AS ok`,
        so.id, event.sequence,
      ),
      stmt(
        db,
        `UPDATE sales_orders SET fulfillment_state = ?, fulfillment_reason = ?, fms_outbound_ref = ?, last_fms_sequence = ?,
                status = CASE WHEN ? = 'HANDED_OVER' AND status IN ('open', 'cancel_requested') THEN 'shipped'
                              WHEN ? = 'CANCELLED' THEN 'cancelled' ELSE status END,
                updated_at = datetime('now')
          WHERE id = ?`,
        state, p.reason, p.outboundRef, event.sequence, p.state, p.state, so.id,
      ),
      timelineStmt(db, so.number, "fms_state", detail),
      auditStmt(db, null, so.number, "fms_state", detail),
    ]);
    return { status: 200, ack: applied };
  } catch (err) {
    // A concurrent delivery of the same or a newer event got there first.
    const again = await get<{ result: string | null }>(db, "SELECT result FROM fms_inbox WHERE event_id = ?", event.eventId);
    if (again) return { status: 200, ack: duplicateAck(again.result) };
    const now = await get<{ last_fms_sequence: number }>(db, "SELECT last_fms_sequence FROM sales_orders WHERE id = ?", so.id);
    if (now && event.sequence <= now.last_fms_sequence) return { status: 200, ack: await recordOnly(db, event.eventId, stale) };
    throw err;
  }
}

function duplicateAck(result: string | null): Ack {
  const first = result ? (JSON.parse(result) as Ack) : { received: true as const, duplicate: false, applied: true };
  return { ...first, received: true, duplicate: true };
}

async function recordOnly(db: D1Database, eventId: string, ack: Ack): Promise<Ack> {
  await batch(db, [stmt(db, "INSERT OR IGNORE INTO fms_inbox(event_id, result) VALUES (?, ?)", eventId, JSON.stringify(ack))]);
  return ack;
}
