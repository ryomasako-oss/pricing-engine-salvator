-- 2026-10-06 (Ryoma, from DEVA's review of #2): the COGS reference moves
-- only when a manager confirms a COGS ("COGS ini benar", POST verify-cogs).
--
-- 0009 let every change within 50% move the reference, so a few small steps
-- could carry COGS far from where it started without ever being flagged
-- (50.000 -> 72.000 -> 103.000 = +106%). Now the triggers only record history
-- and set a reference the first time an item has a COGS; after that only
-- verify-cogs changes it. Express mirrors this in server/db.ts.

DROP TRIGGER IF EXISTS trg_cogs_update;
DROP TRIGGER IF EXISTS trg_cogs_insert;

CREATE TRIGGER trg_cogs_update
AFTER UPDATE OF cogs ON catalog_items
WHEN NEW.cogs <> OLD.cogs
BEGIN
  INSERT INTO catalog_cogs_history(code, cogs) SELECT OLD.code, OLD.cogs WHERE OLD.cogs > 0;
  INSERT INTO catalog_cogs_baseline(code, cogs) SELECT OLD.code, OLD.cogs
   WHERE OLD.cogs > 0 AND NOT EXISTS (SELECT 1 FROM catalog_cogs_baseline WHERE code = OLD.code);
  INSERT INTO catalog_cogs_baseline(code, cogs) SELECT NEW.code, NEW.cogs
   WHERE NEW.cogs > 0 AND NOT EXISTS (SELECT 1 FROM catalog_cogs_baseline WHERE code = NEW.code);
END;

CREATE TRIGGER trg_cogs_insert
AFTER INSERT ON catalog_items
WHEN NEW.cogs > 0
BEGIN
  INSERT INTO catalog_cogs_baseline(code, cogs) SELECT NEW.code, NEW.cogs
   WHERE NOT EXISTS (SELECT 1 FROM catalog_cogs_baseline WHERE code = NEW.code);
END;
