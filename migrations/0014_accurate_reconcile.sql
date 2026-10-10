-- 2026-10-08 (Ryoma): the catalog is cross-checked against Accurate after every
-- completed sync run. reconciled_at (ISO, like last_success_at) is when that
-- check last ran for the entity; the check is due while it is older than the
-- last completed run, so a run is checked exactly once, in its own cron tick.
ALTER TABLE accurate_sync_state ADD COLUMN reconciled_at TEXT;
