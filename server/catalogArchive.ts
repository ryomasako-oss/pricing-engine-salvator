/* SQL arsip barang (shared/catalogArchive.ts), dipakai router Katalog dan Duplikat. */

/** Barang aktif saja: dipakai daftar Katalog dan indeks pencarian. Sinkron/Terapkan/Tarik stok TIDAK memakainya. */
export const NOT_ARCHIVED = "archived_at IS NULL";

/** ?1 = entity katalog (catalogEntity). Selesai bila ditandai manual, non aktif di sinkron, atau hilang dari Accurate
 *  (hanya bila sinkron entity itu sudah pernah mengisi tabel; tabel kosong = belum tahu = belum). */
const ACCURATE_STATUS = `CASE
    WHEN c.accurate_off_at IS NOT NULL THEN 'sudah'
    WHEN EXISTS (SELECT 1 FROM accurate_items a WHERE a.entity = ?1 AND a.code = c.code)
      THEN CASE WHEN EXISTS (SELECT 1 FROM accurate_items a WHERE a.entity = ?1 AND a.code = c.code AND a.suspended = 0) THEN 'belum' ELSE 'sudah' END
    WHEN EXISTS (SELECT 1 FROM accurate_items a WHERE a.entity = ?1) THEN 'sudah'
    ELSE 'belum' END`;

const ARCHIVED_SELECT = `
  SELECT c.id, c.code, c.name, c.uom, c.category, c.stock, c.archived_at, ub.name AS archived_by_name, c.archived_note,
         c.accurate_off_at, uo.name AS accurate_off_by_name, ${ACCURATE_STATUS} AS accurate_status
    FROM catalog_items c
    LEFT JOIN users ub ON ub.id = c.archived_by
    LEFT JOIN users uo ON uo.id = c.accurate_off_by`;

/** ?1 entity, ?2 teks cari (LIKE, boleh '%'), ?3 limit, ?4 offset. */
export const LIST_ARCHIVED_SQL = `${ARCHIVED_SELECT}
   WHERE c.archived_at IS NOT NULL AND (c.code LIKE ?2 OR c.name LIKE ?2)
   ORDER BY c.archived_at DESC, c.id DESC LIMIT ?3 OFFSET ?4`;

export const COUNT_ARCHIVED_SQL = "SELECT COUNT(*) AS n FROM catalog_items WHERE archived_at IS NOT NULL AND (code LIKE ?1 OR name LIKE ?1)";

/** ?1 entity, ?2.. id barang (kartu laporan Duplikat yang sudah di-ACC). */
export const archivedByIdsSql = (n: number) =>
  `${ARCHIVED_SELECT} WHERE c.archived_at IS NOT NULL AND c.id IN (${Array.from({ length: n }, (_, i) => `?${i + 2}`).join(", ")})`;

export const GET_ARCHIVED_SQL = `${ARCHIVED_SELECT} WHERE c.id = ?2`;

export const RESTORE_SQL = `UPDATE catalog_items SET archived_at = NULL, archived_by = NULL, archived_note = '', accurate_off_at = NULL, accurate_off_by = NULL
   WHERE id = ? AND archived_at IS NOT NULL`;

export const MARK_ACCURATE_OFF_SQL = `UPDATE catalog_items SET accurate_off_at = datetime('now'), accurate_off_by = ?
   WHERE id = ? AND archived_at IS NOT NULL AND accurate_off_at IS NULL`;

/** Arsipkan barang yang kalah di satu kelompok ACC. Jalan hanya bila kelompok itu memang di-ACC oleh admin ini dengan barang
 *  yang sama (dua ACC bersamaan: yang kalah balapan tidak mengarsipkan apa-apa).
 *  Parameter: admin, id dipakai (untuk catatan), id yang diarsipkan x n, id dipakai, group_key, id dipakai, admin. */
export const archiveLosersSql = (n: number) => `
  UPDATE catalog_items
     SET archived_at = datetime('now'), archived_by = ?, archived_note = 'Duplikat dari ' || COALESCE((SELECT code FROM catalog_items WHERE id = ?), ''),
         accurate_off_at = NULL, accurate_off_by = NULL
   WHERE id IN (${Array(n).fill("?").join(", ")}) AND archived_at IS NULL AND id <> ?
     AND EXISTS (SELECT 1 FROM duplicate_reports
                  WHERE COALESCE(group_key, 'id-' || id) = ? AND status = 'approved' AND kept_item_id = ? AND decided_by = ?)`;
