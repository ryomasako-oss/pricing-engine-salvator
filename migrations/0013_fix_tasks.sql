-- 2026-10-06 (Ryoma): "Perlu diperbaiki". What didn't make it into an
-- approved offer (not in the catalog, COGS held, unit without a ratio,
-- rejected by sales) stays here until someone fixes it and marks it done,
-- so the client gets the rest without waiting. See shared/fixTasks.ts.
-- `dedupe` keeps one open task per problem per quote line.

CREATE TABLE IF NOT EXISTS fix_tasks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL,
  quote_id    INTEGER REFERENCES quotes(id) ON DELETE CASCADE,
  line_id     TEXT,
  code        TEXT NOT NULL DEFAULT '',
  item_name   TEXT NOT NULL,
  qty         REAL NOT NULL DEFAULT 0,
  uom         TEXT NOT NULL DEFAULT '',
  detail      TEXT NOT NULL DEFAULT '',
  dedupe      TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open',
  created_by  INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_by INTEGER REFERENCES users(id),
  resolved_at TEXT,
  resolution  TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_fix_tasks_open ON fix_tasks(dedupe) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_fix_tasks_status ON fix_tasks(status, created_at);
CREATE INDEX IF NOT EXISTS idx_fix_tasks_quote ON fix_tasks(quote_id);
