import { Router } from "express";
import { all, get, run, tx } from "../db.js";
import { audit } from "../audit.js";
import { type AuthedRequest, requireAuth, requirePermission } from "../auth.js";
import { zodMessage } from "../validate.js";
import { hasPermission } from "../../shared/permissions.js";
import { normalizeCode } from "../../shared/duplicates.js";
import { newItemTaskDetail, type PendingItem } from "../../shared/pendingItems.js";
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
} from "../pendingItems.js";

/* "Barang baru" (shared/pendingItems.ts): requested by anyone, handed to Accurate by a manager. */
export const pendingItemsRouter = Router();
pendingItemsRouter.use(requireAuth);

/** Items the catalog has by now are linked and their tasks done; safe to repeat. */
const sweep = () => {
  run(LINK_PENDING_SQL);
  run(CLOSE_LINKED_TASKS_SQL);
};

pendingItemsRouter.get("/", (req: AuthedRequest, res) => {
  sweep();
  const scoped = !hasPermission(req.user!.role, "edit_catalog");
  res.json({ items: all<PendingItem>(listPendingSql(scoped), ...(scoped ? [req.user!.id] : [])) });
});

pendingItemsRouter.post("/", (req: AuthedRequest, res) => {
  const parsed = pendingItemSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: zodMessage(parsed.error) });
    return;
  }
  const { name, uom, proposed_price, note, code } = parsed.data;
  if (code && get(CODE_TAKEN_SQL, normalizeCode(code))) {
    res.status(409).json({ error: `Kode ${code} sudah dipakai di katalog atau permintaan barang baru lain.` });
    return;
  }
  // The same name in the catalog means the item exists: use it instead of asking for a twin.
  const twin = get<{ code: string; name: string }>("SELECT code, name FROM catalog_items WHERE lower(trim(name)) = lower(trim(?)) LIMIT 1", name);
  if (twin) {
    res.status(409).json({ error: `Barang ini sudah ada di katalog: ${twin.code} (${twin.name}). Pakai yang itu.`, existing: twin });
    return;
  }
  let id: number;
  try {
    id = Number(run(INSERT_PENDING_SQL, code ?? "", name, uom || "Pcs", proposed_price, note, req.user!.id).lastInsertRowid);
  } catch (err) {
    if (String((err as Error).message).includes("UNIQUE")) {
      res.status(409).json({ error: "Kode itu baru saja dipakai permintaan lain. Coba lagi." });
      return;
    }
    throw err;
  }
  const item = get<PendingItem>(GET_PENDING_SQL, id)!;
  audit(req.user!.id, "pending_item", id, "created", { code: item.code, name: item.name });
  res.status(201).json({ item });
});

pendingItemsRouter.post("/:id/submit", requirePermission("edit_catalog"), (req: AuthedRequest, res) => {
  sweep();
  const id = Number(req.params.id);
  const item = get<PendingItem>(GET_PENDING_SQL, id);
  if (!item) {
    res.status(404).json({ error: "Permintaan barang baru tidak ditemukan." });
    return;
  }
  if (item.status === "linked") {
    res.status(409).json({ error: "Barang ini sudah ada di katalog." });
    return;
  }
  if (item.status !== "draft") {
    res.status(409).json({ error: item.status === "submitted" ? "Sudah diajukan ke Accurate." : "Permintaan ini sudah dibatalkan." });
    return;
  }
  tx(() => {
    run("UPDATE pending_items SET status = 'submitted', submitted_by = ?, submitted_at = datetime('now') WHERE id = ? AND status = 'draft'", req.user!.id, id);
    run(INSERT_NEW_ITEM_TASK_SQL, item.code, item.name, item.uom, newItemTaskDetail(item), req.user!.id);
  });
  audit(req.user!.id, "pending_item", id, "submitted", { code: item.code });
  res.json({ item: get<PendingItem>(GET_PENDING_SQL, id) });
});

pendingItemsRouter.post("/:id/cancel", requirePermission("edit_catalog"), (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const item = get<PendingItem>(GET_PENDING_SQL, id);
  if (!item) {
    res.status(404).json({ error: "Permintaan barang baru tidak ditemukan." });
    return;
  }
  if (item.status === "linked" || item.status === "cancelled") {
    res.status(409).json({ error: item.status === "linked" ? "Barang ini sudah ada di katalog." : "Sudah dibatalkan." });
    return;
  }
  tx(() => {
    run("UPDATE pending_items SET status = 'cancelled' WHERE id = ? AND status IN ('draft', 'submitted')", id);
    run(CLOSE_NEW_ITEM_TASK_SQL, item.code, req.user!.id, "Permintaan dibatalkan.");
  });
  audit(req.user!.id, "pending_item", id, "cancelled", { code: item.code });
  res.json({ ok: true });
});
