-- Migration 26: Bills System Contract v1
-- Aligns bills + bill_payments tables with BILLS_SECTION_CONTRACT.md
-- Adds source tracking columns to transactions for bill linkage
-- Run: wrangler d1 execute sovereign-finance --remote --file=migrations/26_bills_contract_v1.sql

-- ============================================================
-- PART 1: ADD MISSING COLUMNS TO bills TABLE
-- All columns nullable or have DEFAULT to satisfy D1 ALTER TABLE rules
-- ============================================================

ALTER TABLE bills ADD COLUMN expected_amount REAL;
ALTER TABLE bills ADD COLUMN default_account_id TEXT;
ALTER TABLE bills ADD COLUMN last_paid_date TEXT;
ALTER TABLE bills ADD COLUMN last_paid_account_id TEXT;
ALTER TABLE bills ADD COLUMN auto_post INTEGER DEFAULT 0;
ALTER TABLE bills ADD COLUMN archived_at TEXT;
ALTER TABLE bills ADD COLUMN deleted_at TEXT;
ALTER TABLE bills ADD COLUMN updated_at TEXT;
ALTER TABLE bills ADD COLUMN owner_user_id TEXT DEFAULT 'user_owner';
ALTER TABLE bills ADD COLUMN household_id TEXT DEFAULT 'hh_owner';

-- Backfill expected_amount from amount where missing
UPDATE bills SET expected_amount = amount WHERE expected_amount IS NULL AND amount IS NOT NULL;

-- ============================================================
-- PART 2: CREATE bill_payments TABLE (full schema)
-- Uses IF NOT EXISTS — safe to run even if table already exists
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
-- PART 3: ADD MISSING COLUMNS TO bill_payments (if table existed before)
-- Safe: IF NOT EXISTS not supported for ALTER TABLE in SQLite,
-- so these run only if the column is truly missing.
-- Comment out any that already exist in your D1 instance.
-- ============================================================

ALTER TABLE bill_payments ADD COLUMN bill_month TEXT;
ALTER TABLE bill_payments ADD COLUMN amount_paisa INTEGER;
ALTER TABLE bill_payments ADD COLUMN paid_amount REAL;
ALTER TABLE bill_payments ADD COLUMN paid_amount_paisa INTEGER;
ALTER TABLE bill_payments ADD COLUMN category_id TEXT;
ALTER TABLE bill_payments ADD COLUMN payment_date TEXT;
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
-- Required for bill payment linkage (source_module, source_id, source_action)
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
-- Updates any transaction that has a bill payment marker but wrong category
-- ============================================================

UPDATE transactions
   SET category_id = 'bills'
 WHERE (notes LIKE '%[BILL_PAYMENT]%' OR source_module = 'bills')
   AND category_id = 'bills_utilities';

-- Verify:
-- SELECT COUNT(*) FROM bill_payments;
-- SELECT COUNT(*) FROM bills;
-- PRAGMA table_info(bill_payments);
-- PRAGMA table_info(transactions);
-- SELECT DISTINCT category_id FROM transactions WHERE source_module = 'bills';
