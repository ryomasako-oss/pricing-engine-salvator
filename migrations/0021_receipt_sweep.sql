-- 2026-10-24: housekeeping for goods receipts that Accurate deleted or cancelled.
-- A deleted receipt never appears in receive-item/list.do again, so the regular
-- lastUpdate pass can never replace or drop its lines. Once every few passes the
-- sync lists every receipt id and deletes the lines of ids it no longer sees.
--
-- The sweep is resumable: sweep_page + sweep_ids hold a partly collected id list
-- when one tick's call budget runs out, and nothing is deleted until the list is
-- complete and its length matches Accurate's rowCount.

ALTER TABLE accurate_receipt_state ADD COLUMN passes_since_sweep INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accurate_receipt_state ADD COLUMN sweep_page INTEGER NOT NULL DEFAULT 1;
ALTER TABLE accurate_receipt_state ADD COLUMN sweep_ids TEXT; -- JSON array, only while a sweep is in flight
ALTER TABLE accurate_receipt_state ADD COLUMN last_sweep_at TEXT;
