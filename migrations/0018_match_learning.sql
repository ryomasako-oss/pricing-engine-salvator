-- 2026-10-16 (Ryoma): the matcher should get better at a client's wording
-- instead of guessing from scratch every time.
--
-- catalog_aliases (0008) already stores a confirmed pairing, but it is only
-- written when a quote is built from a client's list AND a client is chosen
-- AND the row was corrected. In production that never happened once: 30
-- quotes, 0 aliases. Worse, it only keeps what was RIGHT, so a guess the rep
-- threw away teaches nothing and can be made again tomorrow.
--
-- This table records every row of a reviewed list, right or wrong, with or
-- without a client. It is an observation log, never a rule: a rule still
-- needs a client (see POST /catalog/aliases). It answers "how often is the
-- matcher right", "which wording does it keep missing", and it feeds the
-- penalty that stops a rejected pairing from being auto-accepted again.

CREATE TABLE IF NOT EXISTS match_feedback (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id  INTEGER NOT NULL DEFAULT 0,   -- 0 = no client was chosen
  text       TEXT NOT NULL,                -- shared/match.ts normalizeText() of the client's wording
  raw_text   TEXT NOT NULL,                -- as the client wrote it, for the report
  status     TEXT NOT NULL,                -- what the matcher said: exact | match | review | none
  via        TEXT NOT NULL DEFAULT '',     -- code | alias | name | '' (nothing scored)
  suggested  TEXT,                         -- top candidate's code, NULL when there was none
  score      REAL NOT NULL DEFAULT 0,      -- that candidate's score, 1 for an exact hit
  chosen     TEXT,                         -- the code the rep used; NULL = row left out
  outcome    TEXT NOT NULL,                -- accepted | corrected | dropped | new_item
  user_id    INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- "has this wording been rejected for this code?", the penalty's lookup.
CREATE INDEX IF NOT EXISTS idx_match_feedback_pair ON match_feedback(text, suggested);
-- The report reads by week.
CREATE INDEX IF NOT EXISTS idx_match_feedback_time ON match_feedback(created_at);
