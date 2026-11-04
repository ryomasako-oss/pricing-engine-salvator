-- 2026-11-02: one product photo per catalog item, keyed by code (not catalog id) so a
-- catalog re-import keeps it. A separate table: the catalog list never reads the image
-- text, only `v`, which changes on every upload and busts the browser cache.
CREATE TABLE IF NOT EXISTS catalog_images (
  code       TEXT PRIMARY KEY COLLATE NOCASE,
  image      TEXT NOT NULL,
  v          INTEGER NOT NULL,
  updated_by INTEGER,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
