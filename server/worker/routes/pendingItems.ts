import { Hono } from "hono";
import { all, batch, get, run, stmt } from "../../db.d1";
import { audit } from "../audit";
import { requireAuth, requirePermission } from "../auth";
import { zodMessage } from "../../validate";
import { hasPermission } from "../../../shared/permissions";
import { normalizeCode } from "../../../shared/duplicates";
import { newItemTaskDetail, type PendingItem } from "../../../shared/pendingItems";
import {
  CLOSE_LINKED_TASKS_SQL,
  CLOSE_NEW_ITEM_TASK_SQL,
  CODE_TAKEN_SQL,
  GET_PENDING_SQL,
  INSERT_NEW_ITEM_TASK_SQL,
  INSERT_PENDING_SQL,
  LINK_PENDING_SQL,
  listPendingSql,
  pendingItemSchema,
} from "../../pendingItems";
import type { Env } from "../env";

/* "Barang baru" (shared/pendingItems.ts): requested by anyone, handed to Accurate by a manager. */
export const pendingItemsRouter = new Hono<Env>();
pendingItemsRouter.use(requireAuth);

/** Items the catalog has by now are linked and their tasks done; safe to repeat. */
export async function sweepPending(db: D1Database): Promise<void> {
  await run(db, LINK_PENDING_SQL);
  await run(db, CLOSE_LINKED_TASKS_SQL);
}

pendingItemsRouter.get("/", async (c) => {
  const user = c.get("user")!;
  await sweepPending(c.env.DB);
  const scoped = !hasPermission(user.role, "edit_catalog");
  return c.json({ items: await all<PendingItem>(c.env.DB, listPendingSql(scoped), ...(scoped ? [user.id] : [])) });
});

pendingItemsRouter.post("/", async (c) => {
  const user = c.get("user")!;
  const parsed = pendingItemSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: zodMessage(parsed.error) }, 400);
  const { name, uom, proposed_price, note, code } = parsed.data;
  if (code && (await get(c.env.DB, CODE_TAKEN_SQL, normalizeCode(code)))) {
    return c.json({ error: `Kode ${code} sudah dipakai di katalog atau permintaan barang baru lain.` }, 409);
  }
  // The same name in the catalog means the item exists: use it instead of asking for a twin.
  const twin = await get<{ code: string; name: string }>(c.env.DB, "SELECT code, name FROM catalog_items WHERE lower(trim(name)) = lower(trim(?)) LIMIT 1", name);
  if (twin) return c.json({ error: `Barang ini sudah ada di katalog: ${twin.code} (${twin.name}). Pakai yang itu.`, existing: twin }, 409);
  let id: number;
  try {
    id = (await run(c.env.DB, INSERT_PENDING_SQL, code ?? "", name, uom || "Pcs", proposed_price, note, user.id)).meta.last_row_id;
  } catch (err) {
    if (String((err as Error).message).includes("UNIQUE")) return c.json({ error: "Kode itu baru saja dipakai permintaan lain. Coba lagi." }, 409);
    throw err;
  }
  const item = (await get<PendingItem>(c.env.DB, GET_PENDING_SQL, id))!;
  await audit(c.env.DB, user.id, "pending_item", id, "created", { code: item.code, name: item.name });
  return c.json({ item }, 201);
});

pendingItemsRouter.post("/:id/submit", requirePermission("edit_catalog"), async (c) => {
  const user = c.get("user")!;
  await sweepPending(c.env.DB);
  const id = Number(c.req.param("id"));
  const item = await get<PendingItem>(c.env.DB, GET_PENDING_SQL, id);
  if (!item) return c.json({ error: "Permintaan barang baru tidak ditemukan." }, 404);
  if (item.status === "linked") return c.json({ error: "Barang ini sudah ada di katalog." }, 409);
  if (item.status !== "draft") {
    return c.json({ error: item.status === "submitted" ? "Sudah diajukan ke Accurate." : "Permintaan ini sudah dibatalkan." }, 409);
  }
  await batch(c.env.DB, [
    stmt(c.env.DB, "UPDATE pending_items SET status = 'submitted', submitted_by = ?, submitted_at = datetime('now') WHERE id = ? AND status = 'draft'", user.id, id),
    stmt(c.env.DB, INSERT_NEW_ITEM_TASK_SQL, item.code, item.name, item.uom, newItemTaskDetail(item), user.id),
  ]);
  await audit(c.env.DB, user.id, "pending_item", id, "submitted", { code: item.code });
  return c.json({ item: await get<PendingItem>(c.env.DB, GET_PENDING_SQL, id) });
});

pendingItemsRouter.post("/:id/cancel", requirePermission("edit_catalog"), async (c) => {
  const user = c.get("user")!;
  const id = Number(c.req.param("id"));
  const item = await get<PendingItem>(c.env.DB, GET_PENDING_SQL, id);
  if (!item) return c.json({ error: "Permintaan barang baru tidak ditemukan." }, 404);
  if (item.status === "linked" || item.status === "cancelled") {
    return c.json({ error: item.status === "linked" ? "Barang ini sudah ada di katalog." : "Sudah dibatalkan." }, 409);
  }
  await batch(c.env.DB, [
    stmt(c.env.DB, "UPDATE pending_items SET status = 'cancelled' WHERE id = ? AND status IN ('draft', 'submitted')", id),
    stmt(c.env.DB, CLOSE_NEW_ITEM_TASK_SQL, item.code, user.id, "Permintaan dibatalkan."),
  ]);
  await audit(c.env.DB, user.id, "pending_item", id, "cancelled", { code: item.code });
  return c.json({ ok: true });
});
