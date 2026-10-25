-- 2026-10-26 (audit P3-4): new Accurate items are matched to catalog codes ignoring case
-- ("abc-01" is catalog "ABC-01"). The UNIQUE index on catalog_items.code is binary, so
-- without this one every such lookup would scan the catalog once per Accurate item.
-- Not UNIQUE: codes are stored as they are, and existing case twins must not block it.
CREATE INDEX IF NOT EXISTS idx_catalog_code_nocase ON catalog_items(code COLLATE NOCASE);
