-- 2026-11-04 (Ryoma): "template per klien". The client's tender format for the
-- customer quotation (columns, headings, title, opening/closing text) as JSON;
-- NULL prints the standard document. See shared/docColumns.ts.
ALTER TABLE clients ADD COLUMN doc_template TEXT;
