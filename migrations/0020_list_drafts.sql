-- 2026-10-23 (Ryoma): a client's list uploaded for "Dari list klien" can be
-- saved half-done and handed to a chosen PIC to finish (server/listDrafts.ts).
--
-- Only what the person did is stored: the read request lines (so a PDF is
-- not sent through OCR twice) and their pick per row, by catalog code. No
-- catalog item, price or COGS is stored: opening a draft matches the lines
-- again and lays the picks over the fresh result, so a rep handed a
-- manager's draft never receives the manager's cost view.
--
-- Numbered 0020: an abandoned local familiarity branch holds an unmerged
-- 0019; skipping it keeps wrangler from ever seeing two 0019s.

CREATE TABLE IF NOT EXISTS list_drafts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL DEFAULT '',
  client_id   INTEGER REFERENCES clients(id),
  file_name   TEXT NOT NULL DEFAULT '',
  notes       TEXT NOT NULL DEFAULT '[]',  -- JSON string[]: reader notes shown above the review
  lines       TEXT NOT NULL DEFAULT '[]',  -- JSON RequestLine[]
  choices     TEXT NOT NULL DEFAULT '[]',  -- JSON DraftChoice[], one per line (shared/listDrafts.ts)
  status      TEXT NOT NULL DEFAULT 'open', -- open | done | cancelled
  created_by  INTEGER NOT NULL REFERENCES users(id),
  assigned_to INTEGER REFERENCES users(id), -- the PIC it was sent to; NULL = with its creator
  assigned_by INTEGER REFERENCES users(id),
  assigned_at TEXT,
  assign_note TEXT NOT NULL DEFAULT '',
  quote_id    INTEGER REFERENCES quotes(id), -- set when "Buat quotation" closed it
  version     INTEGER NOT NULL DEFAULT 1,    -- a save carries the version it read: two editors get a 409, not a silent overwrite
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_list_drafts_assignee ON list_drafts(status, assigned_to);
CREATE INDEX IF NOT EXISTS idx_list_drafts_creator ON list_drafts(status, created_by);
