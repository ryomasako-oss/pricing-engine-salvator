-- 2026-10-06 (PE-2, meeting 2026-10-05 #2): a manager sends sales a locked
-- "Cek harga" Excel; sales mark each line ACC or Tolak and the file is
-- imported back. One row per import. `lines` holds only
-- [{id, lineNo, name, decision, reason}] (no prices: the file's numbers are
-- never read). Any Tolak sends the quote back to draft for the manager;
-- the banner on the quote reads the reasons from here.

CREATE TABLE IF NOT EXISTS sales_reviews (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  quote_id    INTEGER NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  rev_no      INTEGER NOT NULL,
  reviewed_by INTEGER NOT NULL REFERENCES users(id),
  lines       TEXT NOT NULL,
  rejected    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sales_reviews_quote ON sales_reviews(quote_id, id);
