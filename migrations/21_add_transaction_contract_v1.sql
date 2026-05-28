-- 21_add_transaction_contract_v1.sql
-- Contract v1: new transaction columns, dry-run cache, system categories
-- Idempotent: uses IF NOT EXISTS for tables/indexes; INSERT OR IGNORE for seeds
-- D1 limitation: ALTER TABLE ADD COLUMN fails if column already exists.
-- If any ALTER TABLE line fails, comment it out and re-run the rest.

-- ─── Transactions: new columns ───────────────────────────────────────────────

-- Transfer linkage (shared UUID across all legs of one transfer)
ALTER TABLE transactions ADD COLUMN transfer_id TEXT;
ALTER TABLE transactions ADD COLUMN linked_transfer_id TEXT;

-- Type detail
ALTER TABLE transactions ADD COLUMN subtype TEXT;
ALTER TABLE transactions ADD COLUMN reason_code TEXT;
ALTER TABLE transactions ADD COLUMN fee_bearer TEXT DEFAULT 'source';

-- Merchant (raw text alongside merchant_id FK)
ALTER TABLE transactions ADD COLUMN merchant TEXT;
ALTER TABLE transactions ADD COLUMN merchant_name_raw TEXT;

-- Source attribution (which module/action created this)
ALTER TABLE transactions ADD COLUMN source_module TEXT DEFAULT 'manual';
ALTER TABLE transactions ADD COLUMN source_action TEXT DEFAULT 'manual_create';

-- Currency fields
ALTER TABLE transactions ADD COLUMN currency TEXT DEFAULT 'PKR';

-- International purchase columns (inline on transaction row)
ALTER TABLE transactions ADD COLUMN foreign_currency TEXT;
ALTER TABLE transactions ADD COLUMN foreign_amount_minor INTEGER;
ALTER TABLE transactions ADD COLUMN fx_rate_at_commit REAL;
ALTER TABLE transactions ADD COLUMN fx_markup_paisa INTEGER DEFAULT 0;
ALTER TABLE transactions ADD COLUMN international_fee_paisa INTEGER DEFAULT 0;

-- ─── Indexes ─────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_tx_transfer_id
  ON transactions (transfer_id)
  WHERE transfer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tx_linked_transfer
  ON transactions (linked_transfer_id)
  WHERE linked_transfer_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tx_source_module
  ON transactions (source_module);

CREATE INDEX IF NOT EXISTS idx_tx_reason_code
  ON transactions (reason_code)
  WHERE reason_code IS NOT NULL;

-- ─── transaction_dry_runs ─────────────────────────────────────────────────────
-- Caches dry-run results so commit can validate hash without re-normalising

CREATE TABLE IF NOT EXISTS transaction_dry_runs (
  id                        TEXT PRIMARY KEY,
  user_id                   TEXT NOT NULL DEFAULT 'user_owner',
  household_id              TEXT NOT NULL DEFAULT 'hh_owner',
  idempotency_key           TEXT NOT NULL,
  payload_hash              TEXT NOT NULL,
  committable_payload       TEXT NOT NULL,
  computed_preview          TEXT,
  warnings                  TEXT,
  committed                 INTEGER NOT NULL DEFAULT 0,
  committed_transaction_id  TEXT,
  created_at                TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at                TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_dry_runs_idempotency
  ON transaction_dry_runs (idempotency_key);

CREATE INDEX IF NOT EXISTS idx_dry_runs_expires
  ON transaction_dry_runs (expires_at);

CREATE INDEX IF NOT EXISTS idx_dry_runs_hash
  ON transaction_dry_runs (payload_hash);

-- ─── reconciliation_sessions ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS reconciliation_sessions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL DEFAULT 'user_owner',
  household_id TEXT NOT NULL DEFAULT 'hh_owner',
  account_id   TEXT,
  status       TEXT NOT NULL DEFAULT 'open',
  started_at   TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at    TEXT,
  notes        TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─── Categories: fix type column (migration 07 may not have run) ──────────────

UPDATE categories
  SET type = 'expense'
  WHERE id IN ('food', 'grocery', 'transport', 'bills', 'health', 'cc_spend',
               'family', 'personal', 'biller', 'gift', 'other')
    AND (type IS NULL OR type = '' OR type = 'unknown');

UPDATE categories
  SET type = 'income'
  WHERE id IN ('salary', 'salary_income', 'manual_income')
    AND (type IS NULL OR type = '' OR type = 'unknown');

UPDATE categories
  SET type = 'system'
  WHERE id IN ('transfer', 'cc_pay', 'debt', 'cc_spend')
    AND (type IS NULL OR type = '' OR type = 'unknown');

-- ─── System categories: canonical IDs for contract v1 ────────────────────────

INSERT OR IGNORE INTO categories (id, name, icon, type, display_order) VALUES
  ('cat_transfer',      'Transfer',      '🔄', 'system',  900),
  ('cat_adjustment',    'Adjustment',    '⚖️', 'system',  901),
  ('cat_uncategorized', 'Uncategorized', '📦', 'system',  902),
  ('cat_bank_fees',     'Bank Fees',     '🏦', 'expense', 903);
