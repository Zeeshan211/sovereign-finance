-- Migration 26: Bills System Contract v1
-- Safe, minimal — only adds columns that do NOT already exist in D1.
--
-- Run PRAGMA checks first (optional verification):
--   PRAGMA table_info(bills);
--   PRAGMA table_info(bill_payments);
--   PRAGMA table_info(transactions);
--
-- Run: wrangler d1 execute sovereign-finance --remote --file=migrations/26_bills_contract_v1.sql

-- ============================================================
-- PART 1: NEW COLUMNS ON bills TABLE
-- Only adding columns confirmed NOT present from prior migrations.
-- Already present (do NOT add): id, name, amount, due_day, due_date, frequency,
--   category_id, account_id, default_account_id, status, notes, created_at,
--   last_paid_date, last_paid_account_id, deleted_at, updated_at,
--   owner_user_id (migration 03), household_id (migration 03)
-- ============================================================

ALTER TABLE bills ADD COLUMN expected_amount REAL;
ALTER TABLE bills ADD COLUMN auto_post INTEGER DEFAULT 0;
ALTER TABLE bills ADD COLUMN archived_at TEXT;

-- Backfill expected_amount = amount where null
UPDATE bills SET expected_amount = amount WHERE expected_amount IS NULL AND amount IS NOT NULL;

-- ============================================================
-- PART 2: bill_payments TABLE — create if not exists (full schema)
-- Safe: IF NOT EXISTS means no-op if table already exists with all columns.
-- If the table exists but is missing some columns, run the ALTER TABLE
-- statements in PART 3 after confirming with PRAGMA table_info(bill_payments).
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
-- Run PRAGMA table_info(bill_payments) first.
-- Comment out any ALTER statements for columns that already exist.
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
-- Required for bill payment linkage (source_module, source_id, source_action).
-- Check first: PRAGMA table_info(transactions);
-- Comment out any that already exist.
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
-- Rewrites the broken bills_utilities category to the correct bills ID.
-- ============================================================

UPDATE transactions
   SET category_id = 'bills'
 WHERE (notes LIKE '%[BILL_PAYMENT]%' OR source_module = 'bills')
   AND category_id = 'bills_utilities';

-- Verify:
-- SELECT COUNT(*) FROM bill_payments;
-- PRAGMA table_info(bill_payments);
-- SELECT DISTINCT category_id FROM transactions WHERE notes LIKE '%BILL_PAYMENT%';
