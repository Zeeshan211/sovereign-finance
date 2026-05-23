-- Migration 09: Drop dead backup tables from May 2026
-- Run ONLY after confirming no handler references: grep -r "backup_20260504\|debts_delete_backup\|txn_backup" functions/
-- grep confirmed 0 results on 2026-05-23.
-- Run: wrangler d1 execute sovereign-finance --file=migrations/09_drop_dead_backups.sql

DROP TABLE IF EXISTS accounts_backup_20260504;
DROP TABLE IF EXISTS accounts_backup_20260504_ccvalid;
DROP TABLE IF EXISTS budgets_backup_20260504;
DROP TABLE IF EXISTS debts_delete_backup;
DROP TABLE IF EXISTS transactions_backup_20260504_1c_replay;
DROP TABLE IF EXISTS txn_backup_salary_recat_20260504;

-- Verify:
-- SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%backup%';  -- Should be empty
