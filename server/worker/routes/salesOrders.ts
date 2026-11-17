/* Sales Order: daftar, detail, batal (F3.4), kirim ulang event yang diparkir.
   Membuat SO ada di routes/quotes.ts (POST /api/quotes/:id/sales-order). */

import { Hono } from "hono";
import { z } from "zod";
import { batch, get, stmt } from "../../db.d1";
import { requireAuth, requirePermission } from "../auth";
import { hasPermission } from "../../../shared/permissions";
import { zodMessage } from "../../validate";
import {
  SO_DISABLED,
  auditStmt,
  envelope,
  findSalesOrder,
  listSalesOrders,
  outboxStmts,
  salesOrderEnabled,
  fmsOutboundUrl,
  salesOrderEvents,
  soStatusGuard,
  timelineStmt,
} from "../salesOrderService";
import { dispatchSoOutbox } from "../fms/dispatch";
import { canEdit } from "./quotes";
import type { User } from "../../../shared/types";
import type { Env } from "../env";

export const salesOrdersRouter = new Hono<Env>();
salesOrdersRouter.use(requireAuth);

/** Lets the menu and quote screens hide Sales Order while the switch is off. */
salesOrdersRouter.get("/enabled", async (c) => c.json({ enabled: await salesOrderEnabled(c.env.DB) }));

salesOrdersRouter.use(async (c, next) => {
  if (!(await salesOrderEnabled(c.env.DB))) return c.json({ error: SO_DISABLED }, 403);
  await next();
});

const NOT_FOUND = "Sales Order tidak ditemukan.";

salesOrdersRouter.get("/", async (c) => {
  const status = (c.req.query("status") ?? "").trim();
  const q = (c.req.query("q") ?? "").trim();
  const rows = await listSalesOrders(c.env.DB, { status: status === "all" ? "" : status, q });
  return c.json({ salesOrders: rows.map(({ lines: _l, ...r }) => r) });
});

async function quoteOwner(db: D1Database, quoteId: number) {
  return get<{ created_by: number; assigned_to: number | null }>(db, "SELECT created_by, assigned_to FROM quotes WHERE id = ?", quoteId);
}

salesOrdersRouter.get("/:id", async (c) => {
  const user = c.get("user")!;
  const so = await findSalesOrder(c.env.DB, Number(c.req.param("id")));
  if (!so) return c.json({ error: NOT_FOUND }, 404);
  const owner = await quoteOwner(c.env.DB, so.quote_id);
  const parked = await get<{ n: number }>(
    c.env.DB,
    "SELECT COUNT(*) AS n FROM so_outbox WHERE sales_order_id = ? AND parked = 1 AND delivered_at IS NULL",
    so.id,
  );
  const events = await salesOrderEvents(c.env.DB, so.id);
  return c.json({
    salesOrder: { ...so, lines: JSON.parse(so.lines) },
    events: events.map((e) => ({ ...e, detail: e.detail ? JSON.parse(e.detail) : null })),
    parked: parked?.n ?? 0,
    canCancel: so.status === "open" && !!owner && canEdit(user, owner.created_by, owner.assigned_to),
    canResend: hasPermission(user.role, "manage_policy"),
    fmsUrl: fmsOutboundUrl(c.env, so.number),
  });
});

const cancelSchema = z.object({ reason: z.string().trim().min(3, "Tulis alasan pembatalan (minimal 3 huruf).").max(500) });

salesOrdersRouter.post("/:id/cancel", async (c) => {
  const user = c.get("user")! as User;
  const so = await findSalesOrder(c.env.DB, Number(c.req.param("id")));
  if (!so) return c.json({ error: NOT_FOUND }, 404);
  const owner = await quoteOwner(c.env.DB, so.quote_id);
  if (!owner || !canEdit(user, owner.created_by, owner.assigned_to)) return c.json({ error: "Sales Order ini milik pengguna lain." }, 403);
  const parsed = cancelSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: zodMessage(parsed.error) }, 422);
  if (so.status !== "open") return c.json({ error: "Hanya Sales Order yang masih aktif yang bisa dibatalkan." }, 409);

  const reason = parsed.data.reason;
  const event = envelope("sales_order.cancel_requested", { soNumber: so.number, reason });
  try {
    await batch(c.env.DB, [
      soStatusGuard(c.env.DB, so.id, "open"),
      stmt(
        c.env.DB,
        "UPDATE sales_orders SET status = 'cancel_requested', sync_state = 'pending', updated_at = datetime('now') WHERE id = ?",
        so.id,
      ),
      ...outboxStmts(c.env.DB, so.number, event),
      timelineStmt(c.env.DB, so.number, "cancel_requested", { reason, by: user.name }),
      auditStmt(c.env.DB, user.id, so.number, "cancel_requested", { reason }),
    ]);
  } catch (err) {
    const now = await get<{ status: string }>(c.env.DB, "SELECT status FROM sales_orders WHERE id = ?", so.id);
    if (now && now.status !== "open") return c.json({ error: "Status Sales Order baru saja berubah. Muat ulang halaman." }, 409);
    throw err;
  }
  c.executionCtx.waitUntil(dispatchSoOutbox(c.env).catch((err) => console.error("[fms] dispatch failed:", err)));
  return c.json({ ok: true });
});

/** Kirim ulang: puts this SO's undelivered events (parked ones included) back in line. */
salesOrdersRouter.post("/:id/resend", requirePermission("manage_policy"), async (c) => {
  const user = c.get("user")!;
  const so = await findSalesOrder(c.env.DB, Number(c.req.param("id")));
  if (!so) return c.json({ error: NOT_FOUND }, 404);
  const waiting = await get<{ n: number }>(c.env.DB, "SELECT COUNT(*) AS n FROM so_outbox WHERE sales_order_id = ? AND delivered_at IS NULL", so.id);
  if (!waiting?.n) return c.json({ error: "Tidak ada event yang menunggu dikirim." }, 409);
  await batch(c.env.DB, [
    stmt(
      c.env.DB,
      `UPDATE so_outbox SET parked = 0, attempts = 0, next_attempt_at = datetime('now')
        WHERE sales_order_id = ? AND delivered_at IS NULL`,
      so.id,
    ),
    stmt(c.env.DB, "UPDATE sales_orders SET sync_state = 'pending', sync_error = NULL, updated_at = datetime('now') WHERE id = ?", so.id),
    timelineStmt(c.env.DB, so.number, "resend", { by: user.name, events: waiting.n }),
    auditStmt(c.env.DB, user.id, so.number, "resend", { events: waiting.n }),
  ]);
  c.executionCtx.waitUntil(dispatchSoOutbox(c.env).catch((err) => console.error("[fms] dispatch failed:", err)));
  return c.json({ ok: true, events: waiting.n });
});
