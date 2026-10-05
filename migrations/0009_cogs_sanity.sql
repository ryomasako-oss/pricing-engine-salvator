-- 2026-10-05 meeting: an item whose COGS looks wrong must not be sold.
-- "Wrong" (shared/cogsCheck.ts): no COGS, COGS above the catalog's own
-- selling price, or COGS more than 50% away from its reference COGS.
--
-- The reference (catalog_cogs_baseline) is the last COGS that was accepted:
-- a change within 50% of the reference moves it along, a bigger jump leaves
-- it where it was, so the item stays flagged however often the same file is
-- re-imported, until a manager confirms the new value (POST verify-cogs sets
-- the reference to it). It is keyed by code in its own table so a
-- replace-mode import (delete, then re-insert) can't reset it. Triggers keep
-- it on every write path of both backends without touching the routes.
-- Seeded from today's catalog, so the first import after this is covered.
--
-- Trigger bodies use INSERT ... WHERE NOT EXISTS, never INSERT OR IGNORE:
-- an outer statement's conflict clause overrides the one inside a trigger,
-- and the Worker's import is an upsert (ON CONFLICT DO UPDATE), which would
-- turn OR IGNORE into a hard UNIQUE failure.
--
-- catalog_cogs_history keeps every previous value for the reconciliation
-- report; the check itself only reads the reference.

CREATE TABLE IF NOT EXISTS catalog_cogs_baseline (
  code TEXT PRIMARY KEY,
  cogs REAL NOT NULL CHECK (cogs > 0)
);
INSERT OR IGNORE INTO catalog_cogs_baseline(code, cogs)
  SELECT code, cogs FROM catalog_items WHERE cogs > 0;

CREATE TABLE IF NOT EXISTS catalog_cogs_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT NOT NULL,
  cogs        REAL NOT NULL,
  recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_cogs_history_code ON catalog_cogs_history(code, id);

CREATE TRIGGER IF NOT EXISTS trg_cogs_update
AFTER UPDATE OF cogs ON catalog_items
WHEN NEW.cogs <> OLD.cogs
BEGIN
  INSERT INTO catalog_cogs_history(code, cogs) SELECT OLD.code, OLD.cogs WHERE OLD.cogs > 0;
  INSERT INTO catalog_cogs_baseline(code, cogs) SELECT OLD.code, OLD.cogs
   WHERE OLD.cogs > 0 AND NOT EXISTS (SELECT 1 FROM catalog_cogs_baseline WHERE code = OLD.code);
  INSERT INTO catalog_cogs_baseline(code, cogs) SELECT NEW.code, NEW.cogs
   WHERE NEW.cogs > 0 AND NOT EXISTS (SELECT 1 FROM catalog_cogs_baseline WHERE code = NEW.code);
  UPDATE catalog_cogs_baseline SET cogs = NEW.cogs
   WHERE code = NEW.code AND NEW.cogs > 0 AND abs(NEW.cogs - cogs) <= 0.5 * cogs;
END;

CREATE TRIGGER IF NOT EXISTS trg_cogs_insert
AFTER INSERT ON catalog_items
WHEN NEW.cogs > 0
BEGIN
  INSERT INTO catalog_cogs_baseline(code, cogs) SELECT NEW.code, NEW.cogs
   WHERE NOT EXISTS (SELECT 1 FROM catalog_cogs_baseline WHERE code = NEW.code);
  UPDATE catalog_cogs_baseline SET cogs = NEW.cogs
   WHERE code = NEW.code AND abs(NEW.cogs - cogs) <= 0.5 * cogs;
END;

CREATE TRIGGER IF NOT EXISTS trg_cogs_delete
AFTER DELETE ON catalog_items
WHEN OLD.cogs > 0
BEGIN
  INSERT INTO catalog_cogs_history(code, cogs) VALUES (OLD.code, OLD.cogs);
END;
