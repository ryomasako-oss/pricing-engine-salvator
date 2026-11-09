-- 2026-11-09 (Ryoma): pencarian barang belajar dari kebiasaan. Which item was picked after which typed
-- words (shared/catalogSearch.ts queryKey: normalised words, sorted), so it comes first next time.
-- No user is stored: it is the team's habit, and it fades when not picked for a while.
CREATE TABLE IF NOT EXISTS search_picks (
  query_key TEXT NOT NULL,
  code      TEXT NOT NULL,
  picks     INTEGER NOT NULL DEFAULT 0,
  last_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (query_key, code)
);
