/* 2026-11-25 (pemilik): stok katalog kembali ikut Accurate otomatis tiap sinkron (syncTick memanggil pullStock
   tanpa riwayat); hasil cycle count yang di-ACC tidak lagi mengubah stok katalog, melainkan disimpan sebagai stok
   pembanding di stock_counts. stock_unsent tidak diisi lagi (kosong sejak migrasi 0050), jadi syarat IS_UNSENT di
   bawah tidak pernah berlaku.

   Stok katalog (pemilik, 2026-11-20): koreksi stok wajib di-ACC admin, jadi sinkron Accurate TIDAK lagi
   menyalin stok ke katalog (dulu: refreshStock dipanggil cron tiap run selesai, 2026-10-30). Stok katalog
   hanya berubah lewat tombol Tarik (pullStock di bawah), "Terapkan ke katalog" (routes/accurate.ts), atau
   draf stok yang di-ACC (routes/catalog.ts). Sinkron ke accurate_stock tetap jalan.

   Aturan satuan: jumlah Accurate dihitung dalam satuan Accurate, jadi barang yang satuan katalognya beda
   dilewati. Barang yang punya perubahan ACC belum terkirim (stock_unsent) juga dilewati, supaya angka
   Accurate yang lama tidak menimpa koreksi yang sudah disetujui. Tiap barang yang berubah dicatat di
   stock_history. */

import { batch, get, run, stmt } from "../../db.d1";
import type { EntityKey } from "./sync";

export const STOCK_AS_OF_KEY = "accurate_stock_as_of";

/** Total stok Accurate per barang (semua gudang), satuan Accurate; ?1 = entity. */
export const ACCURATE_TOTALS = `SELECT i.code, COALESCE(NULLIF(i.uom, ''), 'Pcs') AS uom,
         COALESCE((SELECT SUM(q.quantity) FROM accurate_stock q WHERE q.entity = ?1 AND q.item_code = i.code), 0) AS qty
    FROM accurate_items i WHERE i.entity = ?1 AND i.suspended = 0 AND i.code <> ''`;

/** Join dari total Accurate (s) ke barang katalog (c) yang satuannya sama. */
export const SAME_UNIT = "c.code = s.code COLLATE NOCASE AND lower(trim(c.uom)) = lower(trim(s.uom))";
export const IS_UNSENT = "EXISTS (SELECT 1 FROM stock_unsent u WHERE u.code = c.code)";

/** Salin total stok Accurate ke katalog; `actorId` = penekan tombol Sinkron. `withHistory` false: sinkron
 *  otomatis tiap run (tidak mencatat ribuan baris riwayat tiap 6 jam). */
export async function pullStock(db: D1Database, entity: EntityKey, actorId: number | null, withHistory = true) {
  const skipped =
    (await get<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM (${ACCURATE_TOTALS}) s JOIN catalog_items c ON ${SAME_UNIT}
        WHERE c.stock IS NOT s.qty AND ${IS_UNSENT}`,
      entity,
    ))?.n ?? 0;
  const history = withHistory ? [
    stmt(
      db,
      `INSERT INTO stock_history(code, uom, qty_before, qty_after, source, filled_by)
       SELECT c.code, c.uom, c.stock, s.qty, 'tarik', ?2
         FROM (${ACCURATE_TOTALS}) s JOIN catalog_items c ON ${SAME_UNIT}
        WHERE c.stock IS NOT s.qty AND NOT ${IS_UNSENT}`,
      entity,
      actorId,
    ),
  ] : [];
  const res = await batch(db, [
    ...history,
    stmt(
      db,
      `UPDATE catalog_items SET stock = s.qty
         FROM (${ACCURATE_TOTALS}) s
        WHERE catalog_items.code = s.code COLLATE NOCASE
          AND lower(trim(catalog_items.uom)) = lower(trim(s.uom))
          AND catalog_items.stock IS NOT s.qty
          AND NOT EXISTS (SELECT 1 FROM stock_unsent u WHERE u.code = catalog_items.code)`,
      entity,
    ),
    stmt(
      db,
      `INSERT INTO settings(key, value)
       SELECT ?2, last_success_at FROM accurate_sync_state WHERE entity = ?1 AND last_success_at IS NOT NULL
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      entity,
      STOCK_AS_OF_KEY,
    ),
  ]);
  const upd = res[history.length];
  return { changed: upd.meta.changes, skipped };
}

/* Stok pembanding (2026-11-25). */

/** Stok Accurate satu barang di satu gudang dari salinan sinkron terakhir; null bila tidak ada. */
export async function syncedWarehouseStock(db: D1Database, entity: EntityKey, code: string, warehouse: string): Promise<number | null> {
  const r = await get<{ n: number | null; rows: number }>(
    db,
    `SELECT SUM(q.quantity) AS n, COUNT(*) AS rows FROM accurate_stock q
       JOIN accurate_warehouses w ON w.entity = q.entity AND w.accurate_id = q.warehouse_id
      WHERE q.entity = ? AND q.item_code = ? COLLATE NOCASE AND w.name = ? COLLATE NOCASE`,
    entity, code, warehouse,
  );
  return r && r.rows > 0 ? (r.n ?? 0) : null;
}

/**
 * Hitungan yang belum masuk Accurate selesai sendiri bila riwayat mutasi menunjukkan penyesuaian persediaan
 * (nomor IA.…) untuk barang dan gudang itu, dibuat sesudah dihitung, dengan jumlah persis sama dengan selisihnya.
 * Satu penyesuaian hanya dipakai untuk satu hitungan.
 */
export async function matchEnteredCounts(db: D1Database, entity: EntityKey): Promise<number> {
  const match = `FROM stock_mutations m
     WHERE m.entity = ?1 AND m.removed_at IS NULL
       AND m.item_no = stock_counts.code COLLATE NOCASE AND m.warehouse = stock_counts.warehouse COLLATE NOCASE
       AND (m.trans_type = 'IA' OR m.trans_number LIKE 'IA.%')
       AND abs(m.qty - (stock_counts.counted - stock_counts.accurate_qty)) < 1e-9
       AND m.created_wib >= datetime(stock_counts.counted_at, '+7 hours')
       AND NOT EXISTS (SELECT 1 FROM stock_counts s2 WHERE s2.entered_ref = m.trans_number AND s2.code = stock_counts.code AND s2.id <> stock_counts.id)`;
  const r = await run(
    db,
    `UPDATE stock_counts SET status = 'entered', entered_at = datetime('now'), entered_how = 'auto',
            entered_ref = (SELECT m.trans_number ${match} ORDER BY m.created_wib, m.accurate_id LIMIT 1)
      WHERE status = 'open' AND accurate_qty IS NOT NULL AND warehouse <> '' AND EXISTS (SELECT 1 ${match})`,
    entity,
  );
  return r.meta.changes;
}
