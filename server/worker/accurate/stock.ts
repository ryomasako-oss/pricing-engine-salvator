/* Stok katalog (pemilik, 2026-11-20): koreksi stok wajib di-ACC admin, jadi sinkron Accurate TIDAK lagi
   menyalin stok ke katalog (dulu: refreshStock dipanggil cron tiap run selesai, 2026-10-30). Stok katalog
   hanya berubah lewat tombol Tarik (pullStock di bawah), "Terapkan ke katalog" (routes/accurate.ts), atau
   draf stok yang di-ACC (routes/catalog.ts). Sinkron ke accurate_stock tetap jalan.

   Aturan satuan: jumlah Accurate dihitung dalam satuan Accurate, jadi barang yang satuan katalognya beda
   dilewati. Barang yang punya perubahan ACC belum terkirim (stock_unsent) juga dilewati, supaya angka
   Accurate yang lama tidak menimpa koreksi yang sudah disetujui. Tiap barang yang berubah dicatat di
   stock_history. */

import { batch, get, stmt } from "../../db.d1";
import type { EntityKey } from "./sync";

export const STOCK_AS_OF_KEY = "accurate_stock_as_of";

/** Total stok Accurate per barang (semua gudang), satuan Accurate; ?1 = entity. */
export const ACCURATE_TOTALS = `SELECT i.code, COALESCE(NULLIF(i.uom, ''), 'Pcs') AS uom,
         COALESCE((SELECT SUM(q.quantity) FROM accurate_stock q WHERE q.entity = ?1 AND q.item_code = i.code), 0) AS qty
    FROM accurate_items i WHERE i.entity = ?1 AND i.suspended = 0 AND i.code <> ''`;

/** Join dari total Accurate (s) ke barang katalog (c) yang satuannya sama. */
export const SAME_UNIT = "c.code = s.code COLLATE NOCASE AND lower(trim(c.uom)) = lower(trim(s.uom))";
export const IS_UNSENT = "EXISTS (SELECT 1 FROM stock_unsent u WHERE u.code = c.code)";

/** Tombol Tarik: salin total stok Accurate ke katalog; `actorId` = penekan tombol. */
export async function pullStock(db: D1Database, entity: EntityKey, actorId: number | null) {
  const confirmed = await confirmMatchedUnsent(db, entity);
  const skipped =
    (await get<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM (${ACCURATE_TOTALS}) s JOIN catalog_items c ON ${SAME_UNIT}
        WHERE c.stock IS NOT s.qty AND ${IS_UNSENT}`,
      entity,
    ))?.n ?? 0;
  const [, upd] = await batch(db, [
    stmt(
      db,
      `INSERT INTO stock_history(code, uom, qty_before, qty_after, source, filled_by)
       SELECT c.code, c.uom, c.stock, s.qty, 'tarik', ?2
         FROM (${ACCURATE_TOTALS}) s JOIN catalog_items c ON ${SAME_UNIT}
        WHERE c.stock IS NOT s.qty AND NOT ${IS_UNSENT}`,
      entity,
      actorId,
    ),
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
  return { changed: upd.meta.changes, skipped, confirmed };
}

/* Input ke Accurate (pemilik, 2026-11-25): selama Kirim mati, Bu Hesti menginput koreksi stok yang sudah di-ACC
   ke Accurate sendiri. Barang keluar dari stock_unsent (lalu Tarik kembali memperbaruinya) bila angka Accurate
   sudah sama dengan katalog saat sinkron, atau bila admin menandainya "sudah diinput" (ada transaksi di Accurate
   di antaranya, jadi angkanya tidak akan pernah sama persis). Dulu tidak ada jalan keluar sama sekali: barang
   yang pernah di-ACC tidak pernah ikut Accurate lagi. */

/** Barang belum tercatat + total Accurate sekarang (null: tidak ada di Accurate atau satuannya beda); ?1 = entity. */
export const UNSENT_ROWS = `SELECT u.code, u.since, c.id AS item_id, c.name, COALESCE(c.uom, '') AS uom, COALESCE(c.stock, 0) AS stock,
    (SELECT COALESCE((SELECT SUM(q.quantity) FROM accurate_stock q WHERE q.entity = ?1 AND q.item_code = i.code), 0)
       FROM accurate_items i
      WHERE i.entity = ?1 AND i.suspended = 0 AND i.code = c.code COLLATE NOCASE
        AND lower(trim(COALESCE(NULLIF(i.uom, ''), 'Pcs'))) = lower(trim(c.uom)) LIMIT 1) AS accurate
    FROM stock_unsent u LEFT JOIN catalog_items c ON c.code = u.code COLLATE NOCASE`;

const MATCHED = `SELECT code, uom, stock FROM (${UNSENT_ROWS}) WHERE accurate IS NOT NULL AND abs(stock - accurate) < 1e-9`;

/** Sesudah sinkron dan saat Tarik: barang yang angka Accurate-nya sudah sama dianggap sudah diinput. */
export async function confirmMatchedUnsent(db: D1Database, entity: EntityKey): Promise<number> {
  const [, del] = await batch(db, [
    stmt(
      db,
      `INSERT INTO stock_history(code, uom, qty_before, qty_after, source, note)
       SELECT code, uom, stock, stock, 'kirim', 'Tercatat di Accurate: angka Accurate sudah sama saat sinkron' FROM (${MATCHED})`,
      entity,
    ),
    stmt(db, `DELETE FROM stock_unsent WHERE code IN (SELECT code FROM (${MATCHED}))`, entity),
  ]);
  return del.meta.changes;
}

/** Tombol "Sudah diinput di Accurate": keluar dari daftar walau angkanya belum sama; `actorId` tercatat di riwayat. */
export async function markUnsentDone(db: D1Database, codes: string[], actorId: number, note: string): Promise<number> {
  const marks = codes.map(() => "?").join(", ");
  const text = `Ditandai sudah diinput di Accurate${note ? `: ${note}` : ""}`;
  const [, del] = await batch(db, [
    stmt(
      db,
      `INSERT INTO stock_history(code, uom, qty_before, qty_after, source, filled_by, note)
       SELECT u.code, COALESCE(c.uom, ''), COALESCE(c.stock, 0), COALESCE(c.stock, 0), 'kirim', ?, ?
         FROM stock_unsent u LEFT JOIN catalog_items c ON c.code = u.code COLLATE NOCASE
        WHERE u.code IN (${marks})`,
      actorId, text, ...codes,
    ),
    stmt(db, `DELETE FROM stock_unsent WHERE code IN (${marks})`, ...codes),
  ]);
  return del.meta.changes;
}
