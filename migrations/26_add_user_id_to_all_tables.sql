-- Migration 26: Canonical user_id on every user-data table + backfill
-- Run: wrangler d1 execute sovereign-finance --remote --file=migrations/26_add_user_id_to_all_tables.sql
-- Requires: 01..25 already executed.
--
-- WHY: middleware sets context.data.user_id but most tables had no user_id
-- column, so handlers could not scope queries → new users saw the owner's
-- data. register.js/oauth-google.js already attempt
--   UPDATE {tbl} SET user_id = ? WHERE user_id IS NULL
-- on first-owner signup; the column never existed so the error was swallowed.
-- This migration adds the column everywhere and backfills existing rows to
-- the first REAL user (the seeded 'user_owner' / owner@local has no
-- password_hash and no oauth identity, so it can never hold a session).
--
-- Like migration 03, ALTER TABLE ADD COLUMN is single-run (SQLite has no
-- IF NOT EXISTS for columns). All columns NULLABLE — backward compatible.
-- No DROP, no column mutation. Append-only ledger untouched (column add only).
--
-- IMPORTANT DEPLOY ORDER: execute this migration BEFORE deploying the code
-- that references user_id, otherwise inserts will fail with "no such column".

-- ── 1. Add user_id to legacy core tables ────────────────────────────────
ALTER TABLE accounts                    ADD COLUMN user_id TEXT;
ALTER TABLE transactions                ADD COLUMN user_id TEXT;
ALTER TABLE bills                       ADD COLUMN user_id TEXT;
ALTER TABLE bill_payments               ADD COLUMN user_id TEXT;
ALTER TABLE budgets                     ADD COLUMN user_id TEXT;
ALTER TABLE categories                  ADD COLUMN user_id TEXT;
ALTER TABLE debts                       ADD COLUMN user_id TEXT;
ALTER TABLE debt_purge_audit            ADD COLUMN user_id TEXT;
ALTER TABLE goals                       ADD COLUMN user_id TEXT;
ALTER TABLE merchants                   ADD COLUMN user_id TEXT;
ALTER TABLE nano_loans                  ADD COLUMN user_id TEXT;
ALTER TABLE reconciliation              ADD COLUMN user_id TEXT;
ALTER TABLE reconciliation_declarations ADD COLUMN user_id TEXT;
ALTER TABLE reconciliation_exceptions   ADD COLUMN user_id TEXT;
ALTER TABLE reconciliation_snapshots    ADD COLUMN user_id TEXT;
ALTER TABLE reconciliation_plans        ADD COLUMN user_id TEXT;
ALTER TABLE statement_imports           ADD COLUMN user_id TEXT;
ALTER TABLE statement_transactions      ADD COLUMN user_id TEXT;
ALTER TABLE salary                      ADD COLUMN user_id TEXT;
ALTER TABLE salary_config               ADD COLUMN user_id TEXT;
ALTER TABLE salary_contracts            ADD COLUMN user_id TEXT;
ALTER TABLE salary_forecast_config      ADD COLUMN user_id TEXT;
ALTER TABLE salary_payslip_components   ADD COLUMN user_id TEXT;
ALTER TABLE salary_payslips             ADD COLUMN user_id TEXT;
ALTER TABLE snapshots                   ADD COLUMN user_id TEXT;
ALTER TABLE intl_package                ADD COLUMN user_id TEXT;
ALTER TABLE audit_log                   ADD COLUMN user_id TEXT;
ALTER TABLE salah_daily_status          ADD COLUMN user_id TEXT;
ALTER TABLE salah_prayer_entries        ADD COLUMN user_id TEXT;

-- ── 2. Backfill legacy rows to the first real user ──────────────────────
-- "First real user" = earliest non-seed user, preferring role='owner'.
-- If no real user exists yet (fresh DB), rows stay NULL and the existing
-- first-owner backfill in register.js / oauth-google.js claims them.
UPDATE accounts                    SET user_id = COALESCE((SELECT id FROM users WHERE id <> 'user_owner' AND role = 'owner' ORDER BY created_at ASC LIMIT 1), (SELECT id FROM users WHERE id <> 'user_owner' ORDER BY created_at ASC LIMIT 1)) WHERE user_id IS NULL;
UPDATE transactions                SET user_id = COALESCE((SELECT id FROM users WHERE id <> 'user_owner' AND role = 'owner' ORDER BY created_at ASC LIMIT 1), (SELECT id FROM users WHERE id <> 'user_owner' ORDER BY created_at ASC LIMIT 1)) WHERE user_id IS NULL;
UPDATE bills                       SET user_id = COALESCE((SELECT id FROM users WHERE id <> 'user_owner' AND role = 'owner' ORDER BY created_at ASC LIMIT 1), (SELECT id FROM users WHERE id <> 'user_owner' ORDER BY created_at ASC LIMIT 1)) WHERE user_id IS NULL;
UPDATE bill_payments               SET user_id = COALESCE((SELECT id FROM users WHERE id <> 'user_owner' AND role = 'owner' ORDER BY created_at ASC LIMIT 1), (SELECT id FROM users WHERE id <> 'user_owner' ORDER BY created_at ASC LIMIT 1)) WHERE user_id IS NULL;
UPDATE budgets                     SET user_id = COALESCE((SELECT id FROM users WHERE id <> 'user_owner' AND role = 'owner' ORDER BY created_at ASC LIMIT 1), (SELECT id FROM users WHERE id <> 'user_owner' ORDER BY created_at ASC LIMIT 1)) WHERE user_id IS NULL;
UPDATE categories                  SET user_id = COALESCE((SELECT id FROM users WHERE id <> 'user_owner' AND role = 'owner' ORDER BY created_at ASC LIMIT 1), (SELECT id FROM users WHERE id <> 'user_owner' ORDER BY created_at ASC LIMIT 1)) WHERE user_id IS NULL;
UPDATE debts                       SET user_id = COALESCE((SELECT id FROM users WHERE id <> 'user_owner' AND role = 'owner' ORDER BY created_at ASC LIMIT 1), (SELECT id FROM users WHERE id <> 'user_owner' ORDER BY created_at ASC LIMIT 1)) WHERE user_id IS NULL;
UPDATE debt_payments               SET user_id = COALESCE((SELECT id FROM users WHERE id <> 'user_owner' AND role = 'owner' ORDER BY created_at ASC LIMIT 1), (SELECT id FROM users WHERE id <> 'user_owner' ORDER BY created_at ASC LIMIT 1)) WHERE user_id IS NULL;
UPDATE debt_purge_audit            SET user_id = COALESCE((SELECT id FROM users WHERE id <> 'user_owner' AND role = 'owner' ORDER BY created_at ASC LIMIT 1), (SELECT id FROM users WHERE id <> 'user_owner' ORDER BY created_at ASC LIMIT 1)) WHERE user_id IS NULL;
UPDATE goals                       SET user_id = COALESCE((SELECT id FROM users WHERE id <> 'user_owner' AND role = 'owner' ORDER BY created_at ASC LIMIT 1), (SELECT id FROM users WHERE id <> 'user_owner' ORDER BY created_at ASC LIMIT 1)) WHERE user_id IS NULL;
UPDATE merchants                   SET user_id = COALESCE((SELECT id FROM users WHERE id <> 'user_owner' AND role = 'owner' ORDER BY created_at ASC LIMIT 1), (SELECT id FROM users WHERE id <> 'user_owner' ORDER BY created_at ASC LIMIT 1)) WHERE user_id IS NULL;
UPDATE nano_loans                  SET user_id = COALESCE((SELECT id FROM users WHERE id <> 'user_owner' AND role = 'owner' ORDER BY created_at ASC LIMIT 1), (SELECT id FROM users WHERE id <> 'user_owner' ORDER BY created_at ASC LIMIT 1)) WHERE user_id IS NULL;
UPDATE reconciliation              SET user_id = COALESCE((SELECT id FROM users WHERE id <> 'user_owner' AND role = 'owner' ORDER BY created_at ASC LIMIT 1), (SELECT id FROM users WHERE id <> 'user_owner' ORDER BY created_at ASC LIMIT 1)) WHERE user_id IS NULL;
UPDATE reconciliation_declarations SET user_id = COALESCE((SELECT id FROM users WHERE id <> 'user_owner' AND role = 'owner' ORDER BY created_at ASC LIMIT 1), (SELECT id FROM users WHERE id <> 'user_owner' ORDER BY created_at ASC LIMIT 1)) WHERE user_id IS NULL;
UPDATE reconciliation_exceptions   SET user_id = COALESCE((SELECT id FROM users WHERE id <> 'user_owner' AND role = 'owner' ORDER BY created_at ASC LIMIT 1), (SELECT id FROM users WHERE id <> 'user_owner' ORDER BY created_at ASC LIMIT 1)) WHERE user_id IS NULL;
UPDATE reconciliation_snapshots    SET user_id = COALESCE((SELECT id FROM users WHERE id <> 'user_owner' AND role = 'owner' ORDER BY created_at ASC LIMIT 1), (SELECT id FROM users WHERE id <> 'user_owner' ORDER BY created_at ASC LIMIT 1)) WHERE user_id IS NULL;
UPDATE reconciliation_plans        SET user_id = COALESCE((SELECT id FROM users WHERE id <> 'user_owner' AND role = 'owner' ORDER BY created_at ASC LIMIT 1), (SELECT id FROM users WHERE id <> 'user_owner' ORDER BY created_at ASC LIMIT 1)) WHERE user_id IS NULL;
UPDATE statement_imports           SET user_id = COALESCE((SELECT id FROM users WHERE id <> 'user_owner' AND role = 'owner' ORDER BY created_at ASC LIMIT 1), (SELECT id FROM users WHERE id <> 'user_owner' ORDER BY created_at ASC LIMIT 1)) WHERE user_id IS NULL;
UPDATE statement_transactions      SET user_id = COALESCE((SELECT id FROM users WHERE id <> 'user_owner' AND role = 'owner' ORDER BY created_at ASC LIMIT 1), (SELECT id FROM users WHERE id <> 'user_owner' ORDER BY created_at ASC LIMIT 1)) WHERE user_id IS NULL;
UPDATE salary                      SET user_id = COALESCE((SELECT id FROM users WHERE id <> 'user_owner' AND role = 'owner' ORDER BY created_at ASC LIMIT 1), (SELECT id FROM users WHERE id <> 'user_owner' ORDER BY created_at ASC LIMIT 1)) WHERE user_id IS NULL;
UPDATE salary_config               SET user_id = COALESCE((SELECT id FROM users WHERE id <> 'user_owner' AND role = 'owner' ORDER BY created_at ASC LIMIT 1), (SELECT id FROM users WHERE id <> 'user_owner' ORDER BY created_at ASC LIMIT 1)) WHERE user_id IS NULL;
UPDATE salary_contracts            SET user_id = COALESCE((SELECT id FROM users WHERE id <> 'user_owner' AND role = 'owner' ORDER BY created_at ASC LIMIT 1), (SELECT id FROM users WHERE id <> 'user_owner' ORDER BY created_at ASC LIMIT 1)) WHERE user_id IS NULL;
UPDATE salary_forecast_config      SET user_id = COALESCE((SELECT id FROM users WHERE id <> 'user_owner' AND role = 'owner' ORDER BY created_at ASC LIMIT 1), (SELECT id FROM users WHERE id <> 'user_owner' ORDER BY created_at ASC LIMIT 1)) WHERE user_id IS NULL;
UPDATE salary_payslip_components   SET user_id = COALESCE((SELECT id FROM users WHERE id <> 'user_owner' AND role = 'owner' ORDER BY created_at ASC LIMIT 1), (SELECT id FROM users WHERE id <> 'user_owner' ORDER BY created_at ASC LIMIT 1)) WHERE user_id IS NULL;
UPDATE salary_payslips             SET user_id = COALESCE((SELECT id FROM users WHERE id <> 'user_owner' AND role = 'owner' ORDER BY created_at ASC LIMIT 1), (SELECT id FROM users WHERE id <> 'user_owner' ORDER BY created_at ASC LIMIT 1)) WHERE user_id IS NULL;
UPDATE snapshots                   SET user_id = COALESCE((SELECT id FROM users WHERE id <> 'user_owner' AND role = 'owner' ORDER BY created_at ASC LIMIT 1), (SELECT id FROM users WHERE id <> 'user_owner' ORDER BY created_at ASC LIMIT 1)) WHERE user_id IS NULL;
UPDATE intl_package                SET user_id = COALESCE((SELECT id FROM users WHERE id <> 'user_owner' AND role = 'owner' ORDER BY created_at ASC LIMIT 1), (SELECT id FROM users WHERE id <> 'user_owner' ORDER BY created_at ASC LIMIT 1)) WHERE user_id IS NULL;
UPDATE audit_log                   SET user_id = COALESCE((SELECT id FROM users WHERE id <> 'user_owner' AND role = 'owner' ORDER BY created_at ASC LIMIT 1), (SELECT id FROM users WHERE id <> 'user_owner' ORDER BY created_at ASC LIMIT 1)) WHERE user_id IS NULL;
UPDATE salah_daily_status          SET user_id = COALESCE((SELECT id FROM users WHERE id <> 'user_owner' AND role = 'owner' ORDER BY created_at ASC LIMIT 1), (SELECT id FROM users WHERE id <> 'user_owner' ORDER BY created_at ASC LIMIT 1)) WHERE user_id IS NULL;
UPDATE salah_prayer_entries        SET user_id = COALESCE((SELECT id FROM users WHERE id <> 'user_owner' AND role = 'owner' ORDER BY created_at ASC LIMIT 1), (SELECT id FROM users WHERE id <> 'user_owner' ORDER BY created_at ASC LIMIT 1)) WHERE user_id IS NULL;

-- ── 3. Re-point rows stamped with the seed 'user_owner' ─────────────────
-- Migrations 21/22 created tables with user_id DEFAULT 'user_owner'.
-- 'user_owner' can never hold a session, so those rows would become
-- invisible once scoping lands. Reassign them to the first real user.
UPDATE transaction_dry_runs         SET user_id = COALESCE((SELECT id FROM users WHERE id <> 'user_owner' AND role = 'owner' ORDER BY created_at ASC LIMIT 1), (SELECT id FROM users WHERE id <> 'user_owner' ORDER BY created_at ASC LIMIT 1), user_id) WHERE user_id = 'user_owner';
UPDATE reconciliation_sessions      SET user_id = COALESCE((SELECT id FROM users WHERE id <> 'user_owner' AND role = 'owner' ORDER BY created_at ASC LIMIT 1), (SELECT id FROM users WHERE id <> 'user_owner' ORDER BY created_at ASC LIMIT 1), user_id) WHERE user_id = 'user_owner';
UPDATE credit_cards                 SET user_id = COALESCE((SELECT id FROM users WHERE id <> 'user_owner' AND role = 'owner' ORDER BY created_at ASC LIMIT 1), (SELECT id FROM users WHERE id <> 'user_owner' ORDER BY created_at ASC LIMIT 1), user_id) WHERE user_id = 'user_owner';
UPDATE card_statements              SET user_id = COALESCE((SELECT id FROM users WHERE id <> 'user_owner' AND role = 'owner' ORDER BY created_at ASC LIMIT 1), (SELECT id FROM users WHERE id <> 'user_owner' ORDER BY created_at ASC LIMIT 1), user_id) WHERE user_id = 'user_owner';
UPDATE card_statement_transactions  SET user_id = COALESCE((SELECT id FROM users WHERE id <> 'user_owner' AND role = 'owner' ORDER BY created_at ASC LIMIT 1), (SELECT id FROM users WHERE id <> 'user_owner' ORDER BY created_at ASC LIMIT 1), user_id) WHERE user_id = 'user_owner';
UPDATE card_interest_accruals       SET user_id = COALESCE((SELECT id FROM users WHERE id <> 'user_owner' AND role = 'owner' ORDER BY created_at ASC LIMIT 1), (SELECT id FROM users WHERE id <> 'user_owner' ORDER BY created_at ASC LIMIT 1), user_id) WHERE user_id = 'user_owner';
UPDATE card_fees                    SET user_id = COALESCE((SELECT id FROM users WHERE id <> 'user_owner' AND role = 'owner' ORDER BY created_at ASC LIMIT 1), (SELECT id FROM users WHERE id <> 'user_owner' ORDER BY created_at ASC LIMIT 1), user_id) WHERE user_id = 'user_owner';
UPDATE card_reconciliation_sessions SET user_id = COALESCE((SELECT id FROM users WHERE id <> 'user_owner' AND role = 'owner' ORDER BY created_at ASC LIMIT 1), (SELECT id FROM users WHERE id <> 'user_owner' ORDER BY created_at ASC LIMIT 1), user_id) WHERE user_id = 'user_owner';
UPDATE installment_plans            SET user_id = COALESCE((SELECT id FROM users WHERE id <> 'user_owner' AND role = 'owner' ORDER BY created_at ASC LIMIT 1), (SELECT id FROM users WHERE id <> 'user_owner' ORDER BY created_at ASC LIMIT 1), user_id) WHERE user_id = 'user_owner';
UPDATE card_subscriptions           SET user_id = COALESCE((SELECT id FROM users WHERE id <> 'user_owner' AND role = 'owner' ORDER BY created_at ASC LIMIT 1), (SELECT id FROM users WHERE id <> 'user_owner' ORDER BY created_at ASC LIMIT 1), user_id) WHERE user_id = 'user_owner';
UPDATE card_disputes                SET user_id = COALESCE((SELECT id FROM users WHERE id <> 'user_owner' AND role = 'owner' ORDER BY created_at ASC LIMIT 1), (SELECT id FROM users WHERE id <> 'user_owner' ORDER BY created_at ASC LIMIT 1), user_id) WHERE user_id = 'user_owner';
UPDATE card_dispute_evidence        SET user_id = COALESCE((SELECT id FROM users WHERE id <> 'user_owner' AND role = 'owner' ORDER BY created_at ASC LIMIT 1), (SELECT id FROM users WHERE id <> 'user_owner' ORDER BY created_at ASC LIMIT 1), user_id) WHERE user_id = 'user_owner';
UPDATE card_benefit_usage           SET user_id = COALESCE((SELECT id FROM users WHERE id <> 'user_owner' AND role = 'owner' ORDER BY created_at ASC LIMIT 1), (SELECT id FROM users WHERE id <> 'user_owner' ORDER BY created_at ASC LIMIT 1), user_id) WHERE user_id = 'user_owner';
UPDATE household_members            SET user_id = COALESCE((SELECT id FROM users WHERE id <> 'user_owner' AND role = 'owner' ORDER BY created_at ASC LIMIT 1), (SELECT id FROM users WHERE id <> 'user_owner' ORDER BY created_at ASC LIMIT 1), user_id) WHERE user_id = 'user_owner';
UPDATE household_member_charges     SET user_id = COALESCE((SELECT id FROM users WHERE id <> 'user_owner' AND role = 'owner' ORDER BY created_at ASC LIMIT 1), (SELECT id FROM users WHERE id <> 'user_owner' ORDER BY created_at ASC LIMIT 1), user_id) WHERE user_id = 'user_owner';
UPDATE household_settlements        SET user_id = COALESCE((SELECT id FROM users WHERE id <> 'user_owner' AND role = 'owner' ORDER BY created_at ASC LIMIT 1), (SELECT id FROM users WHERE id <> 'user_owner' ORDER BY created_at ASC LIMIT 1), user_id) WHERE user_id = 'user_owner';
UPDATE household_settlement_items   SET user_id = COALESCE((SELECT id FROM users WHERE id <> 'user_owner' AND role = 'owner' ORDER BY created_at ASC LIMIT 1), (SELECT id FROM users WHERE id <> 'user_owner' ORDER BY created_at ASC LIMIT 1), user_id) WHERE user_id = 'user_owner';
UPDATE card_trips                   SET user_id = COALESCE((SELECT id FROM users WHERE id <> 'user_owner' AND role = 'owner' ORDER BY created_at ASC LIMIT 1), (SELECT id FROM users WHERE id <> 'user_owner' ORDER BY created_at ASC LIMIT 1), user_id) WHERE user_id = 'user_owner';
UPDATE card_savings_goals           SET user_id = COALESCE((SELECT id FROM users WHERE id <> 'user_owner' AND role = 'owner' ORDER BY created_at ASC LIMIT 1), (SELECT id FROM users WHERE id <> 'user_owner' ORDER BY created_at ASC LIMIT 1), user_id) WHERE user_id = 'user_owner';
UPDATE notification_log             SET user_id = COALESCE((SELECT id FROM users WHERE id <> 'user_owner' AND role = 'owner' ORDER BY created_at ASC LIMIT 1), (SELECT id FROM users WHERE id <> 'user_owner' ORDER BY created_at ASC LIMIT 1), user_id) WHERE user_id = 'user_owner';

-- ── 4. Indexes for user-scoped queries ──────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_accounts_user_id          ON accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_user_id      ON transactions(user_id, date);
CREATE INDEX IF NOT EXISTS idx_bills_user_id             ON bills(user_id);
CREATE INDEX IF NOT EXISTS idx_bill_payments_user_id     ON bill_payments(user_id);
CREATE INDEX IF NOT EXISTS idx_budgets_user_id           ON budgets(user_id);
CREATE INDEX IF NOT EXISTS idx_categories_user_id        ON categories(user_id);
CREATE INDEX IF NOT EXISTS idx_debts_user_id             ON debts(user_id);
CREATE INDEX IF NOT EXISTS idx_goals_user_id             ON goals(user_id);
CREATE INDEX IF NOT EXISTS idx_merchants_user_id         ON merchants(user_id);
CREATE INDEX IF NOT EXISTS idx_nano_loans_user_id        ON nano_loans(user_id);
CREATE INDEX IF NOT EXISTS idx_snapshots_user_id         ON snapshots(user_id);
CREATE INDEX IF NOT EXISTS idx_salary_contracts_user_id  ON salary_contracts(user_id);
CREATE INDEX IF NOT EXISTS idx_salary_payslips_user_id   ON salary_payslips(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_user_id         ON audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_stmt_imports_user_id      ON statement_imports(user_id);
CREATE INDEX IF NOT EXISTS idx_salah_daily_user_id       ON salah_daily_status(user_id);

-- Intentionally NOT scoped (shared/system tables, no user data):
--   users, households, sessions, login_attempts, password_reset_tokens,
--   user_2fa, auth_rate_limits, oauth_identities, account_permissions,
--   settings (app config), intl_rate_config / intl_fx_cache /
--   intl_rate_audit (global FX config), bank_card_defaults (seed
--   metadata), cron_execution_log (system), salah_prayer_times (location
--   lookup), snapshot_data (child of snapshots — scoped via parent).

-- Verify:
-- SELECT user_id, COUNT(*) FROM transactions GROUP BY user_id;
-- SELECT user_id, COUNT(*) FROM accounts GROUP BY user_id;
