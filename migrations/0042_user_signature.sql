-- 2026-11-19 (Ryoma): signature (and stamp) per user for the quotation letter,
-- as a data URL. Printed only on an approved quote (GET /api/quotes/:id/signature).
ALTER TABLE users ADD COLUMN signature TEXT NOT NULL DEFAULT '';
