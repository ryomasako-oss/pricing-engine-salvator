-- Surat perubahan harga ke klien (Ryoma, 2026-11-26): untuk SI yang benar-benar rugi (Jual < Beli), manajer/admin
-- membuat draft surat; manajer/admin lain (atau admin saja, mengikuti aturan blockApprover) meng-ACC sebelum surat
-- bisa dicetak ber-TTD. Harga di surat per satuan yang dibeli klien, sebelum PPN. Harga klien di aplikasi tidak diubah.
CREATE TABLE price_letters (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  number         TEXT NOT NULL UNIQUE,
  invoice_no     TEXT NOT NULL,
  invoice_date   TEXT NOT NULL,
  customer_name  TEXT NOT NULL,
  customer_no    TEXT NOT NULL DEFAULT '',
  client_id      INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  effective_date TEXT NOT NULL,
  note           TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'rejected')),
  created_by     INTEGER NOT NULL REFERENCES users(id),
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  decided_by     INTEGER REFERENCES users(id),
  decided_at     TEXT,
  decision_note  TEXT NOT NULL DEFAULT ''
);
-- Satu surat aktif per SI: yang ditolak boleh dibuat ulang.
CREATE UNIQUE INDEX price_letters_open_invoice ON price_letters(invoice_no) WHERE status <> 'rejected';

CREATE TABLE price_letter_lines (
  letter_id   INTEGER NOT NULL REFERENCES price_letters(id) ON DELETE CASCADE,
  line_no     INTEGER NOT NULL,
  code        TEXT NOT NULL,
  name        TEXT NOT NULL,
  unit        TEXT NOT NULL,
  old_price   REAL NOT NULL,
  cost        REAL NOT NULL,
  receipt_no  TEXT NOT NULL DEFAULT '',
  suggested   REAL NOT NULL,
  new_price   REAL NOT NULL,
  PRIMARY KEY (letter_id, line_no)
);
