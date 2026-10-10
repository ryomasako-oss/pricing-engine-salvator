/* The SQL both backends run for "Barang baru" (shared/pendingItems.ts); each
   backend only supplies the database call. */

import { z } from "zod";
import { normalizeCode } from "../shared/duplicates.js";
import { CANCELLED_ITEM_PROBLEM, PENDING_ITEM_PROBLEM, isAutoCode } from "../shared/pendingItems.js";

export const pendingItemSchema = z.object({
  name: z.string().trim().min(2, "Nama barang minimal 2 huruf.").max(200),
  uom: z.string().trim().max(30).default("Pcs"),
  proposed_price: z.number().min(0).max(1e10).default(0),
  note: z.string().trim().max(500).default(""),
  /**
   * Optional: the real Accurate code, when the requester already knows it.
   * Blank gets BARU-0001, BARU-0002, …, a range nobody may type: a typed one
   * could take the number the counter gives out next. Inner spaces collapse,
   * as in every code lookup (normalizeCode), so "WS  01" matches "WS 01".
   */
  code: z
    .string()
    .trim()
    .max(64)
    .transform((c) => c.replace(/\s+/g, " "))
    .refine((c) => !isAutoCode(c), "Kode BARU-… diberikan otomatis. Kosongkan kodenya, atau isi kode Accurate yang sebenarnya.")
    .optional(),
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

/** Highest BARU-<n> number among these rows' codes (0 when none). */
const maxAutoNo = (table: string) => `
  COALESCE((SELECT MAX(CAST(substr(trim(code), 6) AS INTEGER)) FROM ${table}
             WHERE upper(trim(code)) GLOB 'BARU-[0-9]*'), 0)`;

/**
 * A blank code gets the next "BARU-0001" above every BARU number already in
 * the catalog or on any request, chosen inside the one INSERT. (The next row
 * id was not enough: a catalog item already called BARU-0002 got linked to
 * the new request, and a code typed as the next number blocked every blank
 * request with the same 409 on each retry.)
 */
export const INSERT_PENDING_SQL = `
  INSERT INTO pending_items(code, name, uom, proposed_price, note, requested_by)
  VALUES (COALESCE(NULLIF(?1, ''), 'BARU-' || printf('%04d', 1 + MAX(${maxAutoNo("pending_items")}, ${maxAutoNo("catalog_items")}))),
          ?2, ?3, ?4, ?5, ?6)`;

const placeholders = (n: number, from = 1) => Array.from({ length: n }, (_, i) => `?${from + i}`).join(",");

/**
 * Requested or cancelled "barang baru" whose code the catalog doesn't have,
 * among these normalized codes: `cancelled` is 0 while any request for the
 * code is live. Callers pass only codes the catalog lookup didn't find, so a
 * quote of catalog items spends no extra D1 statement on this.
 */
export const pendingCodesSql = (n: number) => `
  SELECT lower(trim(p.code)) AS key, MIN(p.status = 'cancelled') AS cancelled FROM pending_items p
   WHERE p.status IN ('draft', 'submitted', 'cancelled')
     AND lower(trim(p.code)) IN (${placeholders(n)})
     AND NOT EXISTS (SELECT 1 FROM catalog_items c WHERE lower(trim(c.code)) = lower(trim(p.code)))
   GROUP BY lower(trim(p.code))`;

/**
 * The live requests among these normalized codes shaped like catalog rows (cost 0,
 * negative id), so staff can add a line for one like for any catalog item; it is
 * held on read (see pendingProblems). The proposed price stands in for the list
 * price only for the viewer who requested it (?1): another rep's estimate is theirs.
 */
export const pendingRowsSql = (n: number) => `
  SELECT -p.id AS id, p.code, p.name, p.uom, 0 AS cogs,
         CASE WHEN p.requested_by = ?1 THEN p.proposed_price ELSE 0 END AS list_price, 0 AS stock,
         '' AS category, 'pending' AS source, p.created_at AS updated_at
    FROM pending_items p
   WHERE p.status IN ('draft', 'submitted')
     AND lower(trim(p.code)) IN (${placeholders(n, 2)})
     AND NOT EXISTS (SELECT 1 FROM catalog_items c WHERE lower(trim(c.code)) = lower(trim(p.code)))`;

/** Requested code (as the caller spelled it) -> its "barang baru" problem, for pending or cancelled codes only. */
export function pendingProblems(requested: string[], rows: { key: string; cancelled: number }[]): Map<string, string> {
  const byKey = new Map(rows.map((r) => [r.key, Number(r.cancelled) ? CANCELLED_ITEM_PROBLEM : PENDING_ITEM_PROBLEM]));
  const out = new Map<string, string>();
  for (const code of requested) {
    const problem = code ? byKey.get(normalizeCode(code)) : undefined;
    if (problem) out.set(code, problem);
  }
  return out;
}

/** The lookup keys the catalog rows didn't answer for: only these can be a "barang baru". */
export const keysNotIn = (keys: string[], rows: { code: string }[]): string[] => {
  const found = new Set(rows.map((r) => normalizeCode(r.code)));
  return keys.filter((k) => !found.has(k));
};

/** The catalog has the code now: the request is linked and its task is done. Both are safe to repeat. */
export const LINK_PENDING_SQL = `
  UPDATE pending_items SET status = 'linked', linked_at = datetime('now')
   WHERE status IN ('draft', 'submitted')
     AND EXISTS (SELECT 1 FROM catalog_items c WHERE lower(trim(c.code)) = lower(trim(pending_items.code)))`;

export const CLOSE_LINKED_TASKS_SQL = `
  UPDATE fix_tasks SET status = 'done', resolved_at = datetime('now'), resolution = 'Barang sudah ada di katalog.'
   WHERE kind = 'new_item' AND status = 'open'
     AND EXISTS (SELECT 1 FROM catalog_items c WHERE lower(trim(c.code)) = lower(trim(fix_tasks.code)))`;

/**
 * The open task for one request (?6 = its id); written by "Ajukan ke Accurate",
 * closed when cancelled or linked. Only while the request is still submitted:
 * a cancel landing between the submit's check and its write leaves no task.
 */
export const INSERT_NEW_ITEM_TASK_SQL = `
  INSERT INTO fix_tasks(kind, quote_id, line_id, code, item_name, qty, uom, detail, dedupe, created_by)
  SELECT 'new_item', NULL, NULL, ?1, ?2, 0, ?3, ?4, 'new_item|' || lower(trim(?1)), ?5
   WHERE EXISTS (SELECT 1 FROM pending_items WHERE id = ?6 AND status = 'submitted')
  ON CONFLICT(dedupe) WHERE status = 'open' DO UPDATE SET detail = excluded.detail, item_name = excluded.item_name`;

export const CLOSE_NEW_ITEM_TASK_SQL = `
  UPDATE fix_tasks SET status = 'done', resolved_by = ?2, resolved_at = datetime('now'), resolution = ?3
   WHERE kind = 'new_item' AND status = 'open' AND lower(trim(code)) = lower(trim(?1))`;
