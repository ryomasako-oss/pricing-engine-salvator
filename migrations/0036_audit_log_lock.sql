-- 2026-11-12: audit_log was append-only by convention (server/worker/audit.ts);
-- the database now refuses to change or remove an entry, so an app bug or a
-- stray script cannot rewrite history. Only someone with direct D1 access can
-- still DROP these triggers, which is itself a visible, deliberate step.
CREATE TRIGGER IF NOT EXISTS audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;

CREATE TRIGGER IF NOT EXISTS audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;

-- The Riwayat Audit page reads by date range.
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);
