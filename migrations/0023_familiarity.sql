-- 2026-10-26 (P2-8): the familiarity tables (Pencocokan / "Latih pencocokan")
-- were created at runtime by ensureSchema() on every request, so a later column
-- change could never reach production. The statements below are copied verbatim
-- from server/familiarity.ts (aeb17d0, unchanged since). IF NOT EXISTS stays: the
-- tables already exist in production, where this migration only records them.

CREATE TABLE IF NOT EXISTS familiarity_sessions (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     client_id  INTEGER,
     title      TEXT NOT NULL DEFAULT '',
     source     TEXT NOT NULL DEFAULT 'text',
     created_by INTEGER,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     updated_at TEXT NOT NULL DEFAULT (datetime('now'))
   );

CREATE INDEX IF NOT EXISTS idx_fam_sessions_client ON familiarity_sessions(client_id, id);

CREATE TABLE IF NOT EXISTS familiarity_session_rows (
     id                       INTEGER PRIMARY KEY AUTOINCREMENT,
     session_id               INTEGER NOT NULL,
     line_no                  INTEGER NOT NULL DEFAULT 0,
     raw_text                 TEXT NOT NULL,
     normalized_raw_text      TEXT NOT NULL,
     qty                      REAL NOT NULL DEFAULT 1,
     unit                     TEXT NOT NULL DEFAULT '',
     match_status             TEXT NOT NULL DEFAULT 'none',
     match_via                TEXT NOT NULL DEFAULT '',
     match_score              REAL NOT NULL DEFAULT 0,
     candidates_json          TEXT NOT NULL DEFAULT '[]',
     resolved_action          TEXT,
     resolved_item_id         TEXT,
     resolved_item_code       TEXT NOT NULL DEFAULT '',
     resolved_item_name       TEXT NOT NULL DEFAULT '',
     resolved_pending_item_id INTEGER,
     resolved_by              INTEGER,
     resolved_at              TEXT,
     created_at               TEXT NOT NULL DEFAULT (datetime('now'))
   );

CREATE INDEX IF NOT EXISTS idx_fam_rows_session ON familiarity_session_rows(session_id, id);

CREATE INDEX IF NOT EXISTS idx_fam_rows_text ON familiarity_session_rows(session_id, normalized_raw_text);

CREATE TABLE IF NOT EXISTS familiarity_rules (
     id                  INTEGER PRIMARY KEY AUTOINCREMENT,
     client_id           INTEGER NOT NULL DEFAULT 0,
     session_id          INTEGER NOT NULL DEFAULT 0,
     normalized_raw_text TEXT NOT NULL,
     action              TEXT NOT NULL,
     item_id             TEXT,
     item_code           TEXT NOT NULL DEFAULT '',
     item_name           TEXT NOT NULL DEFAULT '',
     pending_item_id     INTEGER,
     created_by          INTEGER,
     created_at          TEXT NOT NULL DEFAULT (datetime('now')),
     updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
     UNIQUE(client_id, session_id, normalized_raw_text)
   );

CREATE INDEX IF NOT EXISTS idx_fam_rules_text ON familiarity_rules(normalized_raw_text);
