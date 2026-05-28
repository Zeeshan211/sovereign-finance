-- Migration 20: Debt System Contract v1
-- Aligns debts + debt_payments tables with DEBT_CONTRACT.md
-- Creates debt_defers, debt_interest_accruals tables + debt_balances view
-- Run: wrangler d1 execute sovereign-finance --remote --file=migrations/20_debt_contract_v1.sql

-- ============================================================
-- PART 1: ADD COLUMNS TO debts TABLE
-- All columns are nullable or have DEFAULT to satisfy D1 ALTER TABLE rules
-- ============================================================

ALTER TABLE debts ADD COLUMN direction TEXT;
ALTER TABLE debts ADD COLUMN counterparty_type TEXT;
ALTER TABLE debts ADD COLUMN counterparty_name TEXT;
ALTER TABLE debts ADD COLUMN contact_phone TEXT;
ALTER TABLE debts ADD COLUMN contact_email TEXT;
ALTER TABLE debts ADD COLUMN principal_amount INTEGER;
ALTER TABLE debts ADD COLUMN principal_currency TEXT DEFAULT 'PKR';
ALTER TABLE debts ADD COLUMN principal_amount_pkr_at_origination INTEGER;
ALTER TABLE debts ADD COLUMN date_originated TEXT;
ALTER TABLE debts ADD COLUMN expected_repayment_date TEXT;
ALTER TABLE debts ADD COLUMN settlement_date TEXT;
ALTER TABLE debts ADD COLUMN writeoff_date TEXT;
ALTER TABLE debts ADD COLUMN destination_account_id TEXT;
ALTER TABLE debts ADD COLUMN source_account_id TEXT;
ALTER TABLE debts ADD COLUMN funds_moved_at_creation INTEGER DEFAULT 0;
ALTER TABLE debts ADD COLUMN origination_transaction_id TEXT;
ALTER TABLE debts ADD COLUMN interest_rate_pct REAL;
ALTER TABLE debts ADD COLUMN interest_type TEXT;
ALTER TABLE debts ADD COLUMN minimum_payment_amount INTEGER;
ALTER TABLE debts ADD COLUMN payment_frequency TEXT;
ALTER TABLE debts ADD COLUMN writeoff_reason TEXT;
ALTER TABLE debts ADD COLUMN reminder_cadence TEXT DEFAULT 'none';
ALTER TABLE debts ADD COLUMN last_contact_date TEXT;
ALTER TABLE debts ADD COLUMN description TEXT;
ALTER TABLE debts ADD COLUMN reference_number TEXT;
ALTER TABLE debts ADD COLUMN document_url TEXT;
ALTER TABLE debts ADD COLUMN tags TEXT;
ALTER TABLE debts ADD COLUMN collateral TEXT;
ALTER TABLE debts ADD COLUMN guarantor_name TEXT;
ALTER TABLE debts ADD COLUMN trust_level TEXT;
ALTER TABLE debts ADD COLUMN split_with_household INTEGER DEFAULT 0;
ALTER TABLE debts ADD COLUMN updated_at TEXT;

-- ============================================================
-- PART 2: BACKFILL EXISTING ROWS in debts
-- ============================================================

-- Map existing kind (owe/owed) -> contract direction (i_owe/owed_to_me)
UPDATE debts
  SET direction = CASE
    WHEN kind = 'owe'  THEN 'i_owe'
    WHEN kind = 'owed' THEN 'owed_to_me'
    ELSE 'i_owe'
  END
  WHERE direction IS NULL;

-- Copy name -> counterparty_name
UPDATE debts
  SET counterparty_name = name
  WHERE counterparty_name IS NULL;

-- Default counterparty_type for existing rows
UPDATE debts
  SET counterparty_type = 'other'
  WHERE counterparty_type IS NULL;

-- Convert original_amount (Rs REAL) -> principal_amount (paisas INTEGER)
UPDATE debts
  SET principal_amount = CAST(ROUND(original_amount * 100) AS INTEGER)
  WHERE principal_amount IS NULL;

-- Default currency
UPDATE debts
  SET principal_currency = 'PKR'
  WHERE principal_currency IS NULL;

-- Backfill date_originated from created_at
UPDATE debts
  SET date_originated = DATE(created_at)
  WHERE date_originated IS NULL;

-- Backfill updated_at from created_at
UPDATE debts
  SET updated_at = created_at
  WHERE updated_at IS NULL;

-- ============================================================
-- PART 3: ADD COLUMNS TO debt_payments TABLE
-- ============================================================

ALTER TABLE debt_payments ADD COLUMN user_id TEXT;
ALTER TABLE debt_payments ADD COLUMN destination_account_id TEXT;
ALTER TABLE debt_payments ADD COLUMN principal_portion INTEGER;
ALTER TABLE debt_payments ADD COLUMN interest_portion INTEGER;
ALTER TABLE debt_payments ADD COLUMN payment_method TEXT;
ALTER TABLE debt_payments ADD COLUMN received_via TEXT;
ALTER TABLE debt_payments ADD COLUMN receipt_url TEXT;
ALTER TABLE debt_payments ADD COLUMN idempotency_key TEXT;

-- Sparse unique index (allows multiple NULLs, deduplicates non-null keys)
CREATE UNIQUE INDEX IF NOT EXISTS idx_debt_payments_idempotency
  ON debt_payments(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- ============================================================
-- PART 4: CREATE debt_defers TABLE
-- ============================================================

CREATE TABLE IF NOT EXISTS debt_defers (
  id                      TEXT PRIMARY KEY,
  debt_id                 TEXT NOT NULL,
  user_id                 TEXT NOT NULL,
  previous_due_date       TEXT NOT NULL,
  new_due_date            TEXT NOT NULL,
  defer_reason            TEXT NOT NULL,
  late_fee_amount         INTEGER DEFAULT 0,
  late_fee_transaction_id TEXT,
  notes                   TEXT,
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (debt_id) REFERENCES debts(id)
);

CREATE INDEX IF NOT EXISTS idx_debt_defers_debt_id ON debt_defers(debt_id);
CREATE INDEX IF NOT EXISTS idx_debt_defers_user_id ON debt_defers(user_id);

-- ============================================================
-- PART 5: CREATE debt_interest_accruals TABLE
-- Amounts stored as INTEGER (paisas)
-- ============================================================

CREATE TABLE IF NOT EXISTS debt_interest_accruals (
  id                      TEXT PRIMARY KEY,
  debt_id                 TEXT NOT NULL,
  user_id                 TEXT NOT NULL,
  amount                  INTEGER NOT NULL,
  accrual_date            TEXT NOT NULL,
  accrual_type            TEXT NOT NULL DEFAULT 'monthly_interest',
  capitalized             INTEGER DEFAULT 0,
  payment_transaction_id  TEXT,
  notes                   TEXT,
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (debt_id) REFERENCES debts(id)
);

CREATE INDEX IF NOT EXISTS idx_debt_interest_accruals_debt_id ON debt_interest_accruals(debt_id);
CREATE INDEX IF NOT EXISTS idx_debt_interest_accruals_user_id ON debt_interest_accruals(user_id);

-- ============================================================
-- PART 6: CREATE debt_balances VIEW
-- remaining_balance = principal + capitalized_interest - payments_made
-- Uses amount_paisa from debt_payments (stored INTEGER), amount from debt_interest_accruals
-- ============================================================

DROP VIEW IF EXISTS debt_balances;

CREATE VIEW debt_balances AS
SELECT
  d.id,
  d.user_id,
  COALESCE(d.principal_amount, CAST(ROUND(d.original_amount * 100) AS INTEGER)) AS principal_amount,
  COALESCE(
    SUM(CASE WHEN dp.status != 'reversed' THEN COALESCE(dp.amount_paisa, CAST(ROUND(dp.amount * 100) AS INTEGER)) ELSE 0 END),
    0
  ) AS total_paid,
  COALESCE(
    SUM(CASE WHEN dia.capitalized = 1 THEN dia.amount ELSE 0 END),
    0
  ) AS total_interest_capitalized,
  COALESCE(d.principal_amount, CAST(ROUND(d.original_amount * 100) AS INTEGER))
    + COALESCE(SUM(CASE WHEN dia.capitalized = 1 THEN dia.amount ELSE 0 END), 0)
    - COALESCE(SUM(CASE WHEN dp.status != 'reversed' THEN COALESCE(dp.amount_paisa, CAST(ROUND(dp.amount * 100) AS INTEGER)) ELSE 0 END), 0)
  AS remaining_balance
FROM debts d
LEFT JOIN debt_payments dp ON dp.debt_id = d.id
LEFT JOIN debt_interest_accruals dia ON dia.debt_id = d.id
GROUP BY d.id, d.user_id, d.principal_amount, d.original_amount;

-- ============================================================
-- VERIFY (run separately after migration):
-- PRAGMA table_info(debts);
-- PRAGMA table_info(debt_payments);
-- SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'debt%';
-- SELECT name FROM sqlite_master WHERE type='view' AND name='debt_balances';
-- ============================================================
