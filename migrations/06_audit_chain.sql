-- Migration 06: Prepare audit_log for future hash chain
-- Run: wrangler d1 execute sovereign-finance --file=migrations/06_audit_chain.sql
-- All new columns are NULL until hash chain is activated in a future dedicated session.

ALTER TABLE audit_log ADD COLUMN sequence_number  INTEGER;
ALTER TABLE audit_log ADD COLUMN prev_entry_hash  TEXT;
ALTER TABLE audit_log ADD COLUMN entry_hash       TEXT;
ALTER TABLE audit_log ADD COLUMN entity_hash      TEXT;

-- Additional performance index (timestamp column, not created_at)
CREATE INDEX IF NOT EXISTS idx_audit_seq
  ON audit_log(sequence_number);

-- Verify:
-- PRAGMA table_info(audit_log);
-- SELECT COUNT(*) FROM audit_log WHERE sequence_number IS NOT NULL;
