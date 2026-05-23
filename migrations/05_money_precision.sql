-- Migration 05: Add INTEGER paisa columns alongside REAL for future precision migration
-- Run: wrangler d1 execute sovereign-finance --file=migrations/05_money_precision.sql
-- NOTE: REAL columns stay populated alongside paisa for backward compatibility.
-- Handler code continues using REAL columns until a dedicated precision migration session.

-- transactions: paisa columns
ALTER TABLE transactions ADD COLUMN amount_paisa        INTEGER;
ALTER TABLE transactions ADD COLUMN fee_amount_paisa    INTEGER;
ALTER TABLE transactions ADD COLUMN pra_amount_paisa    INTEGER;
ALTER TABLE transactions ADD COLUMN account_delta_paisa INTEGER;

-- Backfill paisa from REAL columns
UPDATE transactions
  SET amount_paisa        = CAST(ROUND(amount * 100) AS INTEGER),
      fee_amount_paisa    = CAST(ROUND(COALESCE(fee_amount, 0) * 100) AS INTEGER),
      pra_amount_paisa    = CAST(ROUND(COALESCE(pra_amount, 0) * 100) AS INTEGER),
      account_delta_paisa = CAST(ROUND(COALESCE(account_delta, 0) * 100) AS INTEGER)
  WHERE amount_paisa IS NULL;

-- accounts: paisa columns
ALTER TABLE accounts ADD COLUMN opening_balance_paisa INTEGER DEFAULT 0;
ALTER TABLE accounts ADD COLUMN credit_limit_paisa    INTEGER;

UPDATE accounts
  SET opening_balance_paisa = CAST(ROUND(COALESCE(opening_balance, 0) * 100) AS INTEGER)
  WHERE opening_balance_paisa = 0 OR opening_balance_paisa IS NULL;

UPDATE accounts
  SET credit_limit_paisa = CAST(ROUND(credit_limit * 100) AS INTEGER)
  WHERE credit_limit IS NOT NULL AND credit_limit_paisa IS NULL;

-- Verify:
-- SELECT id, amount, amount_paisa FROM transactions LIMIT 5;
-- SELECT id, opening_balance, opening_balance_paisa FROM accounts LIMIT 5;
