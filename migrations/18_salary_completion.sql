-- 18_salary_completion.sql
-- Additive: employer-based salary contract fields + payslips table.
-- Safe: uses IF NOT EXISTS for new tables.
-- Note: ALTER TABLE lines will error if a column already exists — ignore those errors.

ALTER TABLE salary_contracts ADD COLUMN employer_name TEXT;
ALTER TABLE salary_contracts ADD COLUMN gross_amount INTEGER DEFAULT 0;
ALTER TABLE salary_contracts ADD COLUMN frequency TEXT DEFAULT 'monthly';
ALTER TABLE salary_contracts ADD COLUMN net_amount_estimate INTEGER DEFAULT 0;
ALTER TABLE salary_contracts ADD COLUMN status TEXT DEFAULT 'active';
ALTER TABLE salary_contracts ADD COLUMN deposit_account_id TEXT;
ALTER TABLE salary_contracts ADD COLUMN start_date TEXT;
ALTER TABLE salary_contracts ADD COLUMN tax_bracket TEXT;
ALTER TABLE salary_contracts ADD COLUMN currency TEXT DEFAULT 'PKR';

CREATE TABLE IF NOT EXISTS salary_payslips (
  id                  TEXT PRIMARY KEY,
  contract_id         TEXT NOT NULL,
  period              TEXT NOT NULL,
  gross               INTEGER NOT NULL DEFAULT 0,
  net                 INTEGER NOT NULL DEFAULT 0,
  deductions          TEXT DEFAULT '[]',
  components          TEXT DEFAULT '[]',
  bonus               INTEGER DEFAULT 0,
  deposit_date        TEXT,
  deposit_account_id  TEXT,
  transaction_id      TEXT,
  notes               TEXT DEFAULT '',
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS salary_config (
  id                  TEXT PRIMARY KEY,
  tax_rates           TEXT DEFAULT '{}',
  default_deductions  TEXT DEFAULT '[]',
  updated_at          TEXT NOT NULL
);
