-- Migration 10: Historical import tracking columns
-- Run: wrangler d1 execute sovereign-finance --file=migrations/10_import_batch_columns.sql
-- OR apply manually via Cloudflare D1 Console (Dashboard > D1 > sovereign-finance > Console)
--
-- Safe to run once. These columns do not exist in previous migrations.
-- If you see "duplicate column name" errors, the migration already ran.

ALTER TABLE transactions ADD COLUMN historical_import INTEGER DEFAULT 0;
ALTER TABLE transactions ADD COLUMN import_batch_id TEXT;

CREATE INDEX IF NOT EXISTS idx_transactions_import_batch ON transactions(import_batch_id);

-- Verify:
-- SELECT COUNT(*) FROM transactions WHERE historical_import = 1;
-- SELECT import_batch_id, COUNT(*) FROM transactions WHERE import_batch_id IS NOT NULL GROUP BY import_batch_id;
