-- Stok pembanding (pemilik, 2026-11-25). Stok di aplikasi kembali ikut Accurate otomatis tiap sinkron; hasil cycle
-- count gudang yang di-ACC disimpan di sini sebagai angka sendiri per gudang, bertanggal, beserta angka Accurate
-- pada saat dihitung. Selisihnya (counted - accurate_qty) tetap, tidak bergeser oleh transaksi sesudahnya, dan
-- itulah yang diinput ke Accurate sebagai penyesuaian persediaan.
-- status: open = belum masuk Accurate; entered = sudah (auto: penyesuaian dengan jumlah sama terlihat di
-- stock_mutations; manual: ditandai admin); matched = saat dihitung sudah sama dengan Accurate.
CREATE TABLE IF NOT EXISTS stock_counts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id         INTEGER,
  code            TEXT NOT NULL,
  uom             TEXT NOT NULL DEFAULT '',
  warehouse       TEXT NOT NULL DEFAULT '',
  counted         REAL NOT NULL,
  accurate_qty    REAL,                -- stok Accurate gudang itu saat dihitung (null: tidak terbaca)
  accurate_source TEXT,                -- 'live' (get-stock.do saat diajukan) | 'sync' (salinan sinkron terakhir)
  counted_at      TEXT NOT NULL,       -- UTC 'YYYY-MM-DD HH:MM:SS', waktu diajukan
  counted_by      INTEGER REFERENCES users(id),
  approved_by     INTEGER REFERENCES users(id),
  approved_at     TEXT NOT NULL DEFAULT (datetime('now')),
  draft_id        INTEGER,
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'entered', 'matched')),
  entered_at      TEXT,
  entered_by      INTEGER REFERENCES users(id),
  entered_how     TEXT,                -- 'auto' | 'manual'
  entered_ref     TEXT NOT NULL DEFAULT '', -- nomor penyesuaian Accurate (auto) atau catatan (manual)
  note            TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS ix_stock_counts_code ON stock_counts(code, warehouse, counted_at);
CREATE INDEX IF NOT EXISTS ix_stock_counts_open ON stock_counts(status, approved_at);

-- Barang yang tertahan di model lama (stok ACC menunggu dikirim, Tarik melewatinya) pindah ke sini sebagai
-- hitungan terbuka tanpa gudang dan tanpa angka Accurate, lalu dilepas supaya stoknya ikut Accurate lagi.
INSERT INTO stock_counts(item_id, code, uom, warehouse, counted, accurate_qty, counted_at, counted_by, approved_by, approved_at, draft_id, status, note)
  SELECT c.id, h.code, h.uom, '', h.qty_after, NULL, h.created_at, h.filled_by, h.approved_by, h.created_at, h.draft_id, 'open',
         'Dari model lama: gudang dan angka Accurate saat dihitung tidak tercatat'
    FROM stock_unsent u
    JOIN stock_history h ON h.id = (SELECT MAX(x.id) FROM stock_history x WHERE x.code = u.code AND x.source IN ('draft_approved', 'import'))
    LEFT JOIN catalog_items c ON c.code = u.code;
DELETE FROM stock_unsent;
