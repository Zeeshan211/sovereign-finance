-- Migration 03: Add user/household attribution columns to financial tables
-- Run: wrangler d1 execute sovereign-finance --file=migrations/03_user_attribution.sql
-- Requires: 01_multiuser_foundation.sql (households/users must exist)
-- All new columns are NULLABLE or have DEFAULT — fully backward-compatible.
-- SQLite ALTER TABLE ADD COLUMN is safe to run once.

-- accounts
ALTER TABLE accounts ADD COLUMN owner_user_id TEXT;
ALTER TABLE accounts ADD COLUMN household_id   TEXT DEFAULT 'hh_owner';

-- transactions
ALTER TABLE transactions ADD COLUMN created_by_user_id  TEXT DEFAULT 'user_owner';
ALTER TABLE transactions ADD COLUMN modified_by_user_id TEXT;
ALTER TABLE transactions ADD COLUMN household_id         TEXT DEFAULT 'hh_owner';

-- bills
ALTER TABLE bills ADD COLUMN owner_user_id TEXT;
ALTER TABLE bills ADD COLUMN household_id   TEXT DEFAULT 'hh_owner';

-- debts
ALTER TABLE debts ADD COLUMN owner_user_id TEXT;
ALTER TABLE debts ADD COLUMN household_id   TEXT DEFAULT 'hh_owner';

-- goals
ALTER TABLE goals ADD COLUMN owner_user_id TEXT;
ALTER TABLE goals ADD COLUMN household_id   TEXT DEFAULT 'hh_owner';

-- budgets
ALTER TABLE budgets ADD COLUMN owner_user_id TEXT;
ALTER TABLE budgets ADD COLUMN household_id   TEXT DEFAULT 'hh_owner';

-- nano_loans
ALTER TABLE nano_loans ADD COLUMN owner_user_id TEXT;
ALTER TABLE nano_loans ADD COLUMN household_id   TEXT DEFAULT 'hh_owner';

-- salary
ALTER TABLE salary ADD COLUMN owner_user_id TEXT;
ALTER TABLE salary ADD COLUMN household_id   TEXT DEFAULT 'hh_owner';

-- Backfill existing rows with default owner
UPDATE accounts     SET owner_user_id = 'user_owner', household_id = 'hh_owner' WHERE owner_user_id IS NULL;
UPDATE transactions SET created_by_user_id = 'user_owner', household_id = 'hh_owner' WHERE created_by_user_id IS NULL;
UPDATE bills        SET owner_user_id = 'user_owner', household_id = 'hh_owner' WHERE owner_user_id IS NULL;
UPDATE debts        SET owner_user_id = 'user_owner', household_id = 'hh_owner' WHERE owner_user_id IS NULL;

-- Indexes for household-scoped queries
CREATE INDEX IF NOT EXISTS idx_accounts_household    ON accounts(household_id);
CREATE INDEX IF NOT EXISTS idx_accounts_owner        ON accounts(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_tx_household          ON transactions(household_id);
CREATE INDEX IF NOT EXISTS idx_tx_created_by         ON transactions(created_by_user_id);
CREATE INDEX IF NOT EXISTS idx_bills_household       ON bills(household_id);
CREATE INDEX IF NOT EXISTS idx_debts_household       ON debts(household_id);

-- Verify:
-- SELECT id, name, owner_user_id, household_id FROM accounts LIMIT 5;
-- PRAGMA table_info(transactions);
