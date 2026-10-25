-- 2026-10-26 (audit P3-7): reads that filter audit_log by action and a time window
-- scanned the whole log, which only grows:
--   * morning recap, items added on their own: action = 'accurate_new_items' AND created_at >= ?
--   * Silvy quota: entity = 'assistant' AND action IN ('ask', 'document') AND created_at >= ?
-- The sales-rejection check (entity, entity_id, action) is already served by idx_audit_entity.
CREATE INDEX IF NOT EXISTS idx_audit_action_created ON audit_log(action, created_at);
