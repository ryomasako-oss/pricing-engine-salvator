/* The SQL both backends run for "Barang baru" (shared/pendingItems.ts); each
   backend only supplies the database call. */

import { z } from "zod";
import { normalizeCode } from "../shared/duplicates.js";
import { PENDING_ITEM_PROBLEM } from "../shared/pendingItems.js";

export const pendingItemSchema = z.object({
  name: z.string().trim().min(2, "Nama barang minimal 2 huruf.").max(200),
  uom: z.string().trim().max(30).default("Pcs"),
  proposed_price: z.number().min(0).max(1e10).default(0),
  note: z.string().trim().max(500).default(""),
  /** Optional: the real Accurate code, when the requester already knows it. Blank gets BARU-0001, BARU-0002, … */
  code: z.string().trim().max(64).optional(),
});

const SELECT = `
  SELECT p.id, p.code, p.name, p.uom, p.proposed_price, p.note, p.status, p.requested_by,
         u.name AS requested_by_name, p.created_at, p.submitted_at, p.linked_at
    FROM pending_items p LEFT JOIN users u ON u.id = p.requested_by`;

/** Managers see every request, staff only their own. Live ones first, then what was linked lately. */
export const listPendingSql = (scoped: boolean) =>
  `${SELECT} WHERE p.status <> 'cancelled'${scoped ? " AND p.requested_by = ?" : ""}
    ORDER BY CASE p.status WHEN 'draft' THEN 0 WHEN 'submitted' THEN 1 ELSE 2 END, p.created_at DESC, p.id DESC LIMIT 300`;

export const GET_PENDING_SQL = `${SELECT} WHERE p.id = ?`;

/** Is this code already taken by a catalog item or another live request? (one row means yes) */
export const CODE_TAKEN_SQL = `
  SELECT 'catalog' AS where_ FROM catalog_items WHERE lower(trim(code)) = ?1
  UNION ALL
  SELECT 'pending' FROM pending_items WHERE lower(trim(code)) = ?1 AND status IN ('draft', 'submitted')
  LIMIT 1`;

/** The next free "BARU-0001" is the next row id, so it can be chosen inside the one INSERT. */
export const INSERT_PENDING_SQL = `
  INSERT INTO pending_items(code, name, uom, proposed_price, note, requested_by)
  VALUES (COALESCE(NULLIF(?1, ''), 'BARU-' || printf('%04d', COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'pending_items'), 0) + 1)),
          ?2, ?3, ?4, ?5, ?6)`;

/** Live requests whose code is not in the catalog yet, among these normalized codes. */
export const pendingCodesSql = (n: number) => `
  SELECT lower(trim(p.code)) AS key FROM pending_items p
   WHERE p.status IN ('draft', 'submitted')
     AND lower(trim(p.code)) IN (${Array.from({ length: n }, () => "?").join(",")})
     AND NOT EXISTS (SELECT 1 FROM catalog_items c WHERE lower(trim(c.code)) = lower(trim(p.code)))`;

/**
 * The live requests among these normalized codes shaped like catalog rows (cost 0,
 * the proposed price as list price, negative id), so staff can add a line for one
 * like for any catalog item; it is held on read (see pendingProblems).
 */
export const pendingRowsSql = (n: number) => `
  SELECT -p.id AS id, p.code, p.name, p.uom, 0 AS cogs, p.proposed_price AS list_price, 0 AS stock,
         '' AS category, 'pending' AS source, p.created_at AS updated_at
    FROM pending_items p
   WHERE p.status IN ('draft', 'submitted')
     AND lower(trim(p.code)) IN (${Array.from({ length: n }, () => "?").join(",")})
     AND NOT EXISTS (SELECT 1 FROM catalog_items c WHERE lower(trim(c.code)) = lower(trim(p.code)))`;

/** Requested code (as the caller spelled it) -> the pending problem, for pending codes only. */
export function pendingProblems(requested: string[], rows: { key: string }[]): Map<string, string> {
  const pending = new Set(rows.map((r) => r.key));
  const out = new Map<string, string>();
  for (const code of requested) if (code && pending.has(normalizeCode(code))) out.set(code, PENDING_ITEM_PROBLEM);
  return out;
}

/** The catalog has the code now: the request is linked and its task is done. Both are safe to repeat. */
export const LINK_PENDING_SQL = `
  UPDATE pending_items SET status = 'linked', linked_at = datetime('now')
   WHERE status IN ('draft', 'submitted')
     AND EXISTS (SELECT 1 FROM catalog_items c WHERE lower(trim(c.code)) = lower(trim(pending_items.code)))`;

export const CLOSE_LINKED_TASKS_SQL = `
  UPDATE fix_tasks SET status = 'done', resolved_at = datetime('now'), resolution = 'Barang sudah ada di katalog.'
   WHERE kind = 'new_item' AND status = 'open'
     AND EXISTS (SELECT 1 FROM catalog_items c WHERE lower(trim(c.code)) = lower(trim(fix_tasks.code)))`;

/** The open task for one request; written by "Ajukan ke Accurate", closed when cancelled or linked. */
export const INSERT_NEW_ITEM_TASK_SQL = `
  INSERT INTO fix_tasks(kind, quote_id, line_id, code, item_name, qty, uom, detail, dedupe, created_by)
  VALUES ('new_item', NULL, NULL, ?1, ?2, 0, ?3, ?4, 'new_item|' || lower(trim(?1)), ?5)
  ON CONFLICT(dedupe) WHERE status = 'open' DO UPDATE SET detail = excluded.detail, item_name = excluded.item_name`;

export const CLOSE_NEW_ITEM_TASK_SQL = `
  UPDATE fix_tasks SET status = 'done', resolved_by = ?2, resolved_at = datetime('now'), resolution = ?3
   WHERE kind = 'new_item' AND status = 'open' AND lower(trim(code)) = lower(trim(?1))`;
