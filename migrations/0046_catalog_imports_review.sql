-- 2026-11-20: perbaikan review impor lewat ACC (PR #176).
-- catalog_drafts.claim: token satu batch ACC; penulisan barang hanya jalan bila draf ini di-claim batch yang sama,
--   jadi "approved" selalu berarti sudah tertulis, dan dua admin tidak bisa menerapkan baris yang sama dua kali.
-- Draf impor unik per (import_id, code): file baru tidak lagi menimpa draf file lama yang masih menunggu.
-- catalog_imports.ready: 1 setelah SEMUA draf file tertulis (unggahan yang putus di tengah tidak pernah tampil).
-- catalog_imports.done_at: file selesai (semua draf diproses, atau impor ganti sudah dihapus/ditolak).
-- catalog_imports.removed: jumlah barang yang dihapus saat ACC terakhir impor ganti (negatif = sedang dihapus).
-- catalog_import_codes: kode barang di file impor ganti; barang yang dihapus dihitung dari sini saat ACC.
ALTER TABLE catalog_drafts ADD COLUMN claim TEXT;
ALTER TABLE catalog_imports ADD COLUMN ready INTEGER NOT NULL DEFAULT 0;
ALTER TABLE catalog_imports ADD COLUMN done_at TEXT;
ALTER TABLE catalog_imports ADD COLUMN removed INTEGER;
UPDATE catalog_imports SET ready = 1;
UPDATE catalog_imports SET done_at = datetime('now')
 WHERE NOT EXISTS (SELECT 1 FROM catalog_drafts d WHERE d.import_id = catalog_imports.id AND d.status = 'pending');

CREATE TABLE catalog_import_codes (
  import_id INTEGER NOT NULL REFERENCES catalog_imports(id),
  code      TEXT NOT NULL,
  PRIMARY KEY (import_id, code)
) WITHOUT ROWID;

DROP INDEX IF EXISTS idx_catalog_drafts_pending;
CREATE UNIQUE INDEX idx_catalog_drafts_pending ON catalog_drafts(code, kind, uom) WHERE status = 'pending' AND kind != 'import';
CREATE UNIQUE INDEX idx_catalog_drafts_pending_import ON catalog_drafts(import_id, code) WHERE status = 'pending' AND kind = 'import';
CREATE INDEX idx_catalog_drafts_import_code ON catalog_drafts(code) WHERE status = 'pending' AND kind = 'import';
CREATE INDEX idx_catalog_drafts_claim ON catalog_drafts(claim) WHERE claim IS NOT NULL;
