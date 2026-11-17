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
  LIVE_TWIN_SQL,
  GET_PENDING_SQL,
  INSERT_NEW_ITEM_TASK_SQL,
  INSERT_PENDING_SQL,
  LINK_PENDING_SQL,
  listPendingSql,
  pendingItemSchema,
} from "../../pendingItems";
import { z } from "zod";
import { barcodeOwner, barcodesByCode, nextInternalBarcode, proposalsByCode, takenMessage } from "../unitBarcodes";
import { sameUom } from "../../../shared/uom";
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
  const items = await all<PendingItem>(c.env.DB, listPendingSql(scoped), ...(scoped ? [user.id] : []));
  // Barcodes and proposed units filled in by warehouse staff, still under the requested code.
  const live = items.filter((i) => i.status === "draft" || i.status === "submitted").map((i) => i.code);
  const barcodes = await barcodesByCode(c.env.DB, live);
  const units = await proposalsByCode(c.env.DB, live);
  return c.json({ items: items.map((i) => ({ ...i, barcodes: barcodes.get(i.code) ?? [], units: units.get(i.code) ?? [] })) });
});

const barcodeText = z.string().trim().max(64).regex(/^[0-9A-Za-z-]*$/, "Barcode hanya boleh huruf, angka, dan tanda minus.");
/** What warehouse staff add to a request: extra units (proposals) and a barcode per unit. */
const warehouseExtras = z.object({
  units: z.array(z.object({ uom: z.string().trim().min(1).max(32), factor: z.number().positive("Isi harus lebih dari 0.").max(1_000_000) })).max(9).default([]),
  barcodes: z.array(z.object({ uom: z.string().trim().min(1).max(32), barcode: barcodeText.optional(), generate: z.boolean().optional() })).max(10).default([]),
});

pendingItemsRouter.post("/", async (c) => {
  const user = c.get("user")!;
  const body = await c.req.json().catch(() => null);
  const parsed = pendingItemSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: zodMessage(parsed.error) }, 400);
  const extrasParsed = warehouseExtras.safeParse(body ?? {});
  if (!extrasParsed.success) return c.json({ error: zodMessage(extrasParsed.error) }, 400);
  const { name, uom, proposed_price, note, code } = parsed.data;
  const base = uom || "Pcs";
  const extras = extrasParsed.data;
  const hasExtras = extras.units.length > 0 || extras.barcodes.some((b) => b.barcode || b.generate);
  const extrasError = checkExtras(base, extras);
  if (extrasError) return c.json({ error: extrasError }, 400);
  for (const b of extras.barcodes) {
    const other = b.barcode ? await barcodeOwner(c.env.DB, b.barcode) : null;
    if (other) return c.json({ error: takenMessage(b.barcode!, other) }, 409);
  }
  if (code && (await get(c.env.DB, CODE_TAKEN_SQL, normalizeCode(code)))) {
    return c.json({ error: `Kode ${code} sudah dipakai di katalog atau permintaan barang baru lain.` }, 409);
  }
  // The same name in the catalog means the item exists: use it instead of asking for a twin.
  const twin = await get<{ code: string; name: string }>(c.env.DB, "SELECT code, name FROM catalog_items WHERE lower(trim(name)) = lower(trim(?)) LIMIT 1", name);
  if (twin) return c.json({ error: `Barang ini sudah ada di katalog: ${twin.code} (${twin.name}). Pakai yang itu.`, existing: twin }, 409);
  if (!code) {
    const dup = await get<PendingItem>(c.env.DB, LIVE_TWIN_SQL, name);
    // Asking again reuses the live request; barcodes for it would land on someone else's request unseen.
    if (dup && hasExtras) return c.json({ error: `Barang ini sudah diajukan sebagai ${dup.code} (${dup.name}). Isi barcodenya di pengajuan itu.`, existing: dup }, 409);
    if (dup) return c.json({ item: dup });
  }
  let id = 0;
  // A blank code is numbered inside the INSERT; two requests at once can pick the same number, so the loser takes the next.
  for (let attempt = 0; !id; attempt++) {
    try {
      id = (await run(c.env.DB, INSERT_PENDING_SQL, code ?? "", name, uom || "Pcs", proposed_price, note, user.id)).meta.last_row_id;
    } catch (err) {
      if (!String((err as Error).message).includes("UNIQUE")) throw err;
      if (code || attempt >= 2) return c.json({ error: "Kode itu baru saja dipakai permintaan lain. Coba lagi." }, 409);
    }
  }
  const item = (await get<PendingItem>(c.env.DB, GET_PENDING_SQL, id))!;
  // Kept under the requested code: they reach the catalog item when it arrives with this code, or
  // move with it when a manager links the request to another Accurate code (POST /:id/link).
  for (const u of extras.units) {
    await run(c.env.DB, "INSERT INTO catalog_unit_proposals(code, uom, factor, proposed_by) VALUES(?, ?, ?, ?)", item.code, u.uom, u.factor, user.id);
  }
  for (const b of extras.barcodes) {
    const barcode = b.barcode || (b.generate ? await nextInternalBarcode(c.env.DB) : null);
    if (!barcode) continue;
    await run(
      c.env.DB,
      "INSERT INTO catalog_unit_barcodes(code, uom, barcode, generated) VALUES(?, ?, ?, ?)",
      item.code, sameUom(b.uom, base) ? base : b.uom, barcode, b.barcode ? 0 : 1,
    );
  }
  await audit(c.env.DB, user.id, "pending_item", id, "created", {
    code: item.code,
    name: item.name,
    ...(hasExtras && { units: extras.units, barcodes: extras.barcodes.filter((b) => b.barcode || b.generate) }),
  });
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
  // The task is written only if the request is still submitted when the batch runs (a cancel may land in between).
  await batch(c.env.DB, [
    stmt(c.env.DB, "UPDATE pending_items SET status = 'submitted', submitted_by = ?, submitted_at = datetime('now') WHERE id = ? AND status = 'draft'", user.id, id),
    stmt(c.env.DB, INSERT_NEW_ITEM_TASK_SQL, item.code, item.name, item.uom, newItemTaskDetail(item), user.id, id),
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
    // Its barcodes are free again, unless the catalog has this code by now.
    ...["catalog_unit_barcodes", "catalog_unit_proposals"].map((t) =>
      stmt(c.env.DB, `DELETE FROM ${t} WHERE code = ? AND NOT EXISTS (SELECT 1 FROM catalog_items WHERE code = ?)`, item.code, item.code),
    ),
  ]);
  await audit(c.env.DB, user.id, "pending_item", id, "cancelled", { code: item.code });
  return c.json({ ok: true });
});

/**
 * Accurate created the item under another code (e.g. BARU-0003 became 80801999): the request is linked
 * to that catalog item, and the warehouse's barcodes and proposed units move to it. A unit the catalog
 * item already has a barcode (or a ratio) for keeps the catalog's; the request's one is dropped and listed.
 */
pendingItemsRouter.post("/:id/link", requirePermission("edit_catalog"), async (c) => {
  const user = c.get("user")!;
  const id = Number(c.req.param("id"));
  const parsed = z.object({ code: z.string().trim().min(1).max(64) }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: zodMessage(parsed.error) }, 400);
  const item = await get<PendingItem>(c.env.DB, GET_PENDING_SQL, id);
  if (!item) return c.json({ error: "Permintaan barang baru tidak ditemukan." }, 404);
  if (item.status !== "draft" && item.status !== "submitted") {
    return c.json({ error: item.status === "linked" ? "Permintaan ini sudah tersambung ke katalog." : "Permintaan ini sudah dibatalkan." }, 409);
  }
  const target = await get<{ code: string; name: string }>(
    c.env.DB, "SELECT code, name FROM catalog_items WHERE lower(trim(code)) = ?", normalizeCode(parsed.data.code),
  );
  if (!target) return c.json({ error: `Kode ${parsed.data.code} belum ada di katalog. Sinkron dan Terapkan data Accurate dulu.` }, 404);
  const from = item.code;
  const dropped = await all<{ uom: string; barcode: string }>(
    c.env.DB,
    `SELECT b.uom, b.barcode FROM catalog_unit_barcodes b
      WHERE b.code = ?1 AND EXISTS (SELECT 1 FROM catalog_unit_barcodes t WHERE t.code = ?2 AND t.uom = b.uom)`,
    from, target.code,
  );
  await batch(c.env.DB, [
    // Dropped first, so the move below never meets the (code, uom) key of the catalog's own barcode.
    stmt(c.env.DB, "DELETE FROM catalog_unit_barcodes WHERE code = ?1 AND uom IN (SELECT uom FROM catalog_unit_barcodes WHERE code = ?2)", from, target.code),
    stmt(c.env.DB, "UPDATE catalog_unit_barcodes SET code = ?2, updated_at = datetime('now') WHERE code = ?1", from, target.code),
    stmt(
      c.env.DB,
      `DELETE FROM catalog_unit_proposals WHERE code = ?1 AND (
         uom IN (SELECT uom FROM catalog_item_uoms WHERE code = ?2) OR uom IN (SELECT uom FROM catalog_unit_proposals WHERE code = ?2)
         OR lower(uom) = (SELECT lower(uom) FROM catalog_items WHERE code = ?2))`,
      from, target.code,
    ),
    stmt(c.env.DB, "UPDATE catalog_unit_proposals SET code = ?2 WHERE code = ?1", from, target.code),
    stmt(
      c.env.DB,
      "UPDATE pending_items SET status = 'linked', linked_at = datetime('now'), linked_code = ? WHERE id = ? AND status IN ('draft', 'submitted')",
      target.code, id,
    ),
    stmt(c.env.DB, CLOSE_NEW_ITEM_TASK_SQL, from, user.id, `Dibuat di Accurate sebagai ${target.code}.`),
  ]);
  await audit(c.env.DB, user.id, "pending_item", id, "linked", { code: from, to: target.code, dropped });
  return c.json({ item: await get<PendingItem>(c.env.DB, GET_PENDING_SQL, id), target, dropped });
});

/** Units and barcodes in one request: names unique, ratios not on the base unit, barcodes only for known units. */
function checkExtras(base: string, extras: z.infer<typeof warehouseExtras>): string | null {
  const names = [base];
  for (const u of extras.units) {
    if (names.some((n) => sameUom(n, u.uom))) return `Satuan ${u.uom} tertulis dua kali.`;
    names.push(u.uom);
  }
  const seen: string[] = [];
  for (const b of extras.barcodes) {
    if (!names.some((n) => sameUom(n, b.uom))) return `Satuan ${b.uom} belum ada di barang ini.`;
    if (b.barcode && seen.includes(b.barcode)) return `Barcode ${b.barcode} tertulis dua kali.`;
    if (b.barcode) seen.push(b.barcode);
  }
  return null;
}
