/* The SQL both backends run for "Duplikat" (shared/duplicateReports.ts);
   each backend only supplies the database call.
   Mirrors server/pendingItems.ts: one shared SQL file, an Express route
   and a Worker route that make the same decisions. */

import { z } from "zod";
import { canonicalPair } from "../shared/duplicateReports.js";

export const duplicateReportSchema = z.object({
  /** Barang pertama jadi acuan; sisanya kembarannya. */
  item_ids: z.array(z.number().int().positive()).min(2, "Centang minimal 2 barang.").max(10, "Maksimal 10 barang sekali lapor."),
  note: z.string().trim().max(500).default(""),
}).refine((d) => new Set(d.item_ids).size === d.item_ids.length, {
  message: "Barang yang sama tercentang dua kali.",
  path: ["item_ids"],
});

export const decideDuplicateSchema = z
  .object({
    decision: z.enum(["approved", "rejected"]),
    /** Wajib saat ACC: barang mana dari pasangan ini yang dipakai. */
    keep_item_id: z.number().int().positive().optional(),
    note: z.string().trim().max(500).default(""),
  })
  .refine((d) => d.decision === "rejected" || d.keep_item_id !== undefined, {
    message: "Pilih barang yang dipakai sebelum ACC.",
    path: ["keep_item_id"],
  });

const SELECT = `
  SELECT d.id, COALESCE(d.group_key, 'id-' || d.id) AS group_key, d.item_a_id, d.item_b_id, d.note, d.status, d.reported_by,
         u.name AS reported_by_name, d.created_at, d.kept_item_id,
         d.decided_by, du.name AS decided_by_name, d.decided_at, d.decision_note,
         COALESCE(a.code, d.item_a_code) AS item_a_code, COALESCE(a.name, d.item_a_name) AS item_a_name,
         COALESCE(b.code, d.item_b_code) AS item_b_code, COALESCE(b.name, d.item_b_name) AS item_b_name
    FROM duplicate_reports d
    LEFT JOIN catalog_items a ON a.id = d.item_a_id
    LEFT JOIN catalog_items b ON b.id = d.item_b_id
    LEFT JOIN users u ON u.id = d.reported_by
    LEFT JOIN users du ON du.id = d.decided_by`;

/** Open reports first (oldest first, like "Perlu diperbaiki"); decided ones newest first. */
export const listDuplicateSql = (status: "open" | "decided" | "all", scoped: boolean) => {
  const where =
    status === "open"
      ? "d.status = 'open'"
      : status === "decided"
        ? "d.status IN ('approved', 'rejected')"
        : "1 = 1";
  const order =
    status === "open" ? "d.created_at ASC, d.id ASC" : "d.created_at DESC, d.id DESC";
  return `${SELECT} WHERE ${where}${scoped ? " AND d.reported_by = ?" : ""} ORDER BY ${order} LIMIT 300`;
};

/** Jumlah kelompok yang menunggu (3 barang kembar = 1). */
export const countDuplicateSql = (scoped: boolean) =>
  `SELECT COUNT(DISTINCT COALESCE(d.group_key, 'id-' || d.id)) AS n FROM duplicate_reports d WHERE d.status = 'open'${scoped ? " AND d.reported_by = ?" : ""}`;

export const GET_DUPLICATE_SQL = `${SELECT} WHERE d.id = ?`;

export const itemsByIdsSql = (n: number) => `SELECT id FROM catalog_items WHERE id IN (${Array(n).fill("?").join(", ")})`;

export const INSERT_DUPLICATE_SQL = `
  INSERT INTO duplicate_reports(item_a_id, item_b_id, item_a_code, item_a_name, item_b_code, item_b_name, note, reported_by, group_key)
  SELECT a.id, b.id, a.code, a.name, b.code, b.name, ?, ?, ?
    FROM catalog_items a, catalog_items b WHERE a.id = ? AND b.id = ?`;

/** ACC/Tolak satu kelompok sekaligus; hanya baris 'open' (diputuskan dua kali bersamaan: yang kedua 0 baris). */
export const DECIDE_DUPLICATE_SQL = `
  UPDATE duplicate_reports
     SET status = ?, kept_item_id = ?, decided_by = ?, decided_at = datetime('now'), decision_note = ?
   WHERE COALESCE(group_key, 'id-' || id) = ? AND status = 'open'`;

export const GROUP_OPEN_SQL = `
  SELECT item_a_id, item_b_id FROM duplicate_reports
   WHERE COALESCE(group_key, 'id-' || id) = ? AND status = 'open'`;

/** Pasangan terurut + kunci dedupe, supaya satu pasangan hanya punya satu laporan terbuka. */
export function pairForInsert(a: number, b: number): [number, number] {
  return canonicalPair(a, b);
}
