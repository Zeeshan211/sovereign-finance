-- Migration 26: Bills System Contract v1
-- Based on confirmed PRAGMA table_info output from D1 (2026-06-01).
--
-- bills table confirmed columns (14):
--   id, name, amount, due_day, frequency, category_id, default_account_id,
--   last_paid_date, auto_post, status, deleted_at, last_paid_account_id,
--   owner_user_id, household_id
--
-- Run: wrangler d1 execute sovereign-finance --remote --file=migrations/26_bills_contract_v1.sql

-- ============================================================
-- PART 1: ADD MISSING COLUMNS TO bills TABLE
-- Confirmed missing via PRAGMA table_info(bills) on 2026-06-01.
-- ============================================================

ALTER TABLE bills ADD COLUMN due_date TEXT;
ALTER TABLE bills ADD COLUMN notes TEXT;
ALTER TABLE bills ADD COLUMN created_at TEXT DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE bills ADD COLUMN updated_at TEXT;
ALTER TABLE bills ADD COLUMN expected_amount REAL;
ALTER TABLE bills ADD COLUMN archived_at TEXT;

-- Backfill expected_amount = amount for all existing rows
UPDATE bills SET expected_amount = amount WHERE expected_amount IS NULL AND amount IS NOT NULL;

-- Backfill created_at for existing rows that have null
UPDATE bills SET created_at = CURRENT_TIMESTAMP WHERE created_at IS NULL;

-- ============================================================
-- PART 2: bill_payments TABLE — create if not exists (full schema)
-- If the table already exists with all columns, this is a no-op.
-- ============================================================

CREATE TABLE IF NOT EXISTS bill_payments (
  id                      TEXT PRIMARY KEY,
  bill_id                 TEXT NOT NULL,
  bill_month              TEXT NOT NULL,
  amount                  REAL NOT NULL,
  amount_paisa            INTEGER,
  paid_amount             REAL,
  paid_amount_paisa       INTEGER,
  account_id              TEXT NOT NULL,
  category_id             TEXT,
  paid_date               TEXT NOT NULL,
  payment_date            TEXT,
  date                    TEXT,
  transaction_id          TEXT,
  txn_id                  TEXT,
  ledger_transaction_id   TEXT,
  bill_name_snapshot      TEXT,
  month                   TEXT,
  cycle_month             TEXT,
  status                  TEXT DEFAULT 'paid',
  reversed_at             TEXT,
  reversal_transaction_id TEXT,
  reversed_by             TEXT,
  notes                   TEXT,
  created_at              TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at              TEXT DEFAULT CURRENT_TIMESTAMP,
  created_by              TEXT DEFAULT 'user_owner'
);

-- ============================================================
-- PART 3: ADD MISSING COLUMNS TO bill_payments
-- Run PRAGMA table_info(bill_payments) first and comment out
-- any ALTER statements for columns that already exist.
-- ============================================================

ALTER TABLE bill_payments ADD COLUMN bill_month TEXT;
ALTER TABLE bill_payments ADD COLUMN amount_paisa INTEGER;
ALTER TABLE bill_payments ADD COLUMN paid_amount REAL;
ALTER TABLE bill_payments ADD COLUMN paid_amount_paisa INTEGER;
ALTER TABLE bill_payments ADD COLUMN category_id TEXT;
ALTER TABLE bill_payments ADD COLUMN payment_date TEXT;
ALTER TABLE bill_payments ADD COLUMN date TEXT;
ALTER TABLE bill_payments ADD COLUMN txn_id TEXT;
ALTER TABLE bill_payments ADD COLUMN ledger_transaction_id TEXT;
ALTER TABLE bill_payments ADD COLUMN bill_name_snapshot TEXT;
ALTER TABLE bill_payments ADD COLUMN month TEXT;
ALTER TABLE bill_payments ADD COLUMN cycle_month TEXT;
ALTER TABLE bill_payments ADD COLUMN status TEXT DEFAULT 'paid';
ALTER TABLE bill_payments ADD COLUMN reversed_at TEXT;
ALTER TABLE bill_payments ADD COLUMN reversal_transaction_id TEXT;
ALTER TABLE bill_payments ADD COLUMN reversed_by TEXT;
ALTER TABLE bill_payments ADD COLUMN updated_at TEXT;
ALTER TABLE bill_payments ADD COLUMN created_by TEXT DEFAULT 'user_owner';

-- ============================================================
-- PART 4: ADD SOURCE TRACKING COLUMNS TO transactions
-- Run PRAGMA table_info(transactions) first and comment out
-- any ALTER statements for columns that already exist.
-- ============================================================

ALTER TABLE transactions ADD COLUMN source_module TEXT;
ALTER TABLE transactions ADD COLUMN source_id     TEXT;
ALTER TABLE transactions ADD COLUMN source_action TEXT;

-- ============================================================
-- PART 5: INDEXES
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_bill_payments_bill_id    ON bill_payments(bill_id);
CREATE INDEX IF NOT EXISTS idx_bill_payments_bill_month ON bill_payments(bill_month);
CREATE INDEX IF NOT EXISTS idx_bill_payments_txn_id     ON bill_payments(transaction_id);
CREATE INDEX IF NOT EXISTS idx_bills_status             ON bills(status);
CREATE INDEX IF NOT EXISTS idx_bills_due_day            ON bills(due_day);
CREATE INDEX IF NOT EXISTS idx_transactions_source      ON transactions(source_module, source_id);

-- ============================================================
-- PART 6: FIX CATEGORY DRIFT on existing bill payment transactions
-- ============================================================

UPDATE transactions
   SET category_id = 'bills'
 WHERE (notes LIKE '%[BILL_PAYMENT]%' OR source_module = 'bills')
   AND category_id = 'bills_utilities';

-- Verify after running:
-- SELECT COUNT(*) FROM bill_payments;
-- PRAGMA table_info(bills);
-- SELECT DISTINCT category_id FROM transactions WHERE notes LIKE '%BILL_PAYMENT%';
