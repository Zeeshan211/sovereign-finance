-- Migration 26: Bills System Contract v1
-- Based on confirmed PRAGMA table_info output from D1 (2026-06-01).
--
-- Confirmed existing columns before this migration ran:
--
-- bills (14): id, name, amount, due_day, frequency, category_id,
--   default_account_id, last_paid_date, auto_post, status, deleted_at,
--   last_paid_account_id, owner_user_id, household_id
--
-- bill_payments (23): id, bill_id, transaction_id, account_id, amount,
--   payment_date, month, notes, created_at, bill_month, status,
--   bill_name_snapshot, expected_amount_paisa, amount_paisa, expected_amount,
--   paid_date, category_id (DEFAULT 'bills_utilities' — known bug, unfixable
--   without table rebuild; handler always writes category_id explicitly),
--   reversed_at, reversal_transaction_id, reason, dry_run_payload_hash,
--   transaction_payload_hash, created_by
--
-- transactions (59): id, date, type, amount, account_id, ...,
--   source_module (DEFAULT 'manual'), source_action (DEFAULT 'manual_create')
--   — source_id was missing
--
-- Run: wrangler d1 execute sovereign-finance --remote --file=migrations/26_bills_contract_v1.sql

-- ============================================================
-- PART 1: ADD MISSING COLUMNS TO bills TABLE
-- ============================================================

ALTER TABLE bills ADD COLUMN due_date TEXT;
ALTER TABLE bills ADD COLUMN notes TEXT;
-- Note: DEFAULT CURRENT_TIMESTAMP not allowed in D1 ALTER TABLE.
-- Use plain TEXT and backfill below.
ALTER TABLE bills ADD COLUMN created_at TEXT;
ALTER TABLE bills ADD COLUMN updated_at TEXT;
ALTER TABLE bills ADD COLUMN expected_amount REAL;
ALTER TABLE bills ADD COLUMN archived_at TEXT;

UPDATE bills SET expected_amount = amount WHERE expected_amount IS NULL AND amount IS NOT NULL;
UPDATE bills SET created_at = datetime('now') WHERE created_at IS NULL;

-- ============================================================
-- PART 2: ADD MISSING COLUMNS TO bill_payments
-- ============================================================

ALTER TABLE bill_payments ADD COLUMN updated_at TEXT;
ALTER TABLE bill_payments ADD COLUMN reversed_by TEXT;
ALTER TABLE bill_payments ADD COLUMN paid_amount REAL;
ALTER TABLE bill_payments ADD COLUMN paid_amount_paisa INTEGER;
ALTER TABLE bill_payments ADD COLUMN date TEXT;
ALTER TABLE bill_payments ADD COLUMN txn_id TEXT;
ALTER TABLE bill_payments ADD COLUMN ledger_transaction_id TEXT;
ALTER TABLE bill_payments ADD COLUMN cycle_month TEXT;

-- Backfill aliases from existing columns
UPDATE bill_payments SET paid_amount = amount WHERE paid_amount IS NULL AND amount IS NOT NULL;
UPDATE bill_payments SET paid_amount_paisa = amount_paisa WHERE paid_amount_paisa IS NULL AND amount_paisa IS NOT NULL;
UPDATE bill_payments SET date = COALESCE(paid_date, payment_date) WHERE date IS NULL;
UPDATE bill_payments SET txn_id = transaction_id WHERE txn_id IS NULL AND transaction_id IS NOT NULL;
UPDATE bill_payments SET ledger_transaction_id = transaction_id WHERE ledger_transaction_id IS NULL AND transaction_id IS NOT NULL;
UPDATE bill_payments SET cycle_month = COALESCE(bill_month, month) WHERE cycle_month IS NULL;

-- ============================================================
-- PART 3: ADD MISSING source_id COLUMN TO transactions
-- source_module and source_action already exist (confirmed).
-- ============================================================

ALTER TABLE transactions ADD COLUMN source_id TEXT;

-- ============================================================
-- PART 4: INDEXES
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_bill_payments_bill_id    ON bill_payments(bill_id);
CREATE INDEX IF NOT EXISTS idx_bill_payments_bill_month ON bill_payments(bill_month);
CREATE INDEX IF NOT EXISTS idx_bill_payments_txn_id     ON bill_payments(transaction_id);
CREATE INDEX IF NOT EXISTS idx_bills_status             ON bills(status);
CREATE INDEX IF NOT EXISTS idx_bills_due_day            ON bills(due_day);
CREATE INDEX IF NOT EXISTS idx_transactions_source      ON transactions(source_module, source_id);

-- ============================================================
-- PART 5: FIX CATEGORY DRIFT on existing bill payment transactions
-- Also fix bill_payments rows that inherited the wrong default.
-- NOTE: Some transactions have orphaned account_id FK references so the
-- UPDATE fails with SQLITE_CONSTRAINT_FOREIGNKEY even when the target
-- category_id IS valid. Must disable FK checks for this data cleanup.
-- First ensure 'bills' exists: INSERT OR IGNORE INTO categories (id, name) VALUES ('bills', 'Bills');
-- ============================================================

PRAGMA foreign_keys = OFF;

UPDATE transactions
   SET category_id = 'bills'
 WHERE (notes LIKE '%[BILL_PAYMENT]%' OR source_module = 'bills')
   AND category_id = 'bills_utilities';

UPDATE bill_payments
   SET category_id = 'bills'
 WHERE category_id = 'bills_utilities';

PRAGMA foreign_keys = ON;

-- ============================================================
-- KNOWN SCHEMA BUG (unfixable without table rebuild):
-- bill_payments.category_id has DEFAULT 'bills_utilities' baked in.
-- The bills handler always writes category_id explicitly so this
-- only affects rows inserted without an explicit value (none in normal flow).
-- ============================================================

-- Verify:
-- PRAGMA table_info(bills);
-- PRAGMA table_info(bill_payments);
-- SELECT DISTINCT category_id FROM transactions WHERE source_module = 'bills';
-- SELECT DISTINCT category_id FROM bill_payments;
