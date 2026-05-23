-- Migration 04: Fix known schema bugs
-- Run: wrangler d1 execute sovereign-finance --file=migrations/04_known_bugs.sql
-- Fixes BUG-2 (missing idempotency_key) and adds account_delta column.

-- BUG-2 fix: Add idempotency_key to transactions
ALTER TABLE transactions ADD COLUMN idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_idempotency
  ON transactions(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Idempotency key dedup table (server-side dedup for all endpoints)
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key                TEXT PRIMARY KEY,
  user_id            TEXT,
  endpoint           TEXT NOT NULL,
  request_body_hash  TEXT,
  response_status    INTEGER,
  response_body      TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at         TEXT NOT NULL DEFAULT (datetime('now', '+24 hours'))
);

CREATE INDEX IF NOT EXISTS idx_idempotency_expires
  ON idempotency_keys(expires_at);

-- account_delta: signed amount column (positive = credit, negative = debit)
-- Replaces type-lookup logic in balance calculations
ALTER TABLE transactions ADD COLUMN account_delta REAL;

UPDATE transactions
  SET account_delta = CASE
    WHEN type IN ('income', 'salary', 'borrow', 'debt_in', 'opening', 'adjustment_positive')
      THEN amount
    WHEN type IN ('expense', 'transfer', 'cc_spend', 'cc_payment', 'atm', 'repay', 'debt_out', 'adjustment_negative')
      THEN -amount
    ELSE amount
  END
  WHERE account_delta IS NULL;

-- Performance indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_transactions_account_date
  ON transactions(account_id, date);

CREATE INDEX IF NOT EXISTS idx_transactions_date
  ON transactions(date);

-- Verify:
-- PRAGMA table_info(transactions);
-- SELECT id, amount, account_delta FROM transactions LIMIT 5;
-- SELECT name FROM sqlite_master WHERE type='table' AND name='idempotency_keys';
