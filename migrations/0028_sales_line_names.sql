-- 2026-11-04 (Ryoma): the name the sales team typed on each sales-invoice line
-- (Accurate detailName), so a client's next list matches the item it was
-- invoiced as (server/catalogMatch.ts, via "si"). name_key is that name through
-- shared/match.ts normalizeText, the key list matching already uses.

ALTER TABLE accurate_sales_lines ADD COLUMN detail_name TEXT NOT NULL DEFAULT '';
ALTER TABLE accurate_sales_lines ADD COLUMN name_key TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_sales_lines_name ON accurate_sales_lines(entity, name_key);

-- Lines synced before this have no name: read every invoice again from the start
-- of the window (the receipts-style first pass; lines are replaced whole).
UPDATE accurate_sales_state
   SET since_update = NULL, max_update = NULL, backfill_since = NULL, page = 1, row_idx = 0,
       receipts_seen = 0, pass_started_at = NULL, last_pass_at = NULL;
