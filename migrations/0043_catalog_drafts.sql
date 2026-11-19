-- 2026-11-19: Draf Perbaikan Divisi Gudang. An Admin Gudang (role `gudang`) works in Katalog as usual, but
-- each save (barcode, Buat barcode, Tambah satuan, Ubah barang) lands here instead of in the catalog. An
-- admin ACCs it (then it is applied, as the admin, with the draft id in the audit) or rejects it with a note.
-- payload = what was asked; before = the item at submission, for the side-by-side view.
CREATE TABLE IF NOT EXISTS catalog_drafts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id     INTEGER NOT NULL,
  code        TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('barcode', 'unit', 'edit')),
  uom         TEXT NOT NULL DEFAULT '' COLLATE NOCASE,
  payload     TEXT NOT NULL,
  before      TEXT NOT NULL DEFAULT '{}',
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  note        TEXT NOT NULL DEFAULT '',
  created_by  INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_by INTEGER REFERENCES users(id),
  reviewed_at TEXT
);
-- One pending draft per SKU and kind (one per item for an edit): a second save replaces the first.
CREATE UNIQUE INDEX IF NOT EXISTS idx_catalog_drafts_pending ON catalog_drafts(code, kind, uom) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_catalog_drafts_status ON catalog_drafts(status, created_at);
