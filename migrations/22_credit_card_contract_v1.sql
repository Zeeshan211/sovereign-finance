-- Migration 22: Credit Card System Contract v1
-- 20 new tables + transactions CC extensions + 15-bank seed + backfill 4 existing CCs
-- Idempotent: uses CREATE TABLE IF NOT EXISTS, ALTER TABLE nullable/DEFAULT, INSERT OR REPLACE seeds
-- D1 rule: ALTER TABLE ADD COLUMN requires nullable or DEFAULT
-- Run: cd /tmp/sovereign-finance && git pull && npx wrangler d1 execute sovereign-finance --remote --file=migrations/22_credit_card_contract_v1.sql

-- ═══════════════════════════════════════════
-- PART A: NEW TABLES (20 tables)
-- ═══════════════════════════════════════════

-- ─── 1. bank_card_defaults ───────────────────────────────────────────────────
-- Reference table with defaults per Pakistani bank. PK ON CONFLICT REPLACE
-- enables seed upsert without conditional logic.

CREATE TABLE IF NOT EXISTS bank_card_defaults (
  bank_id                         TEXT PRIMARY KEY ON CONFLICT REPLACE,
  bank_name                       TEXT NOT NULL,
  apr_pct                         REAL NOT NULL DEFAULT 42.0,
  cash_advance_apr_pct            REAL DEFAULT 42.0,
  cash_advance_fee_pct            REAL DEFAULT 3.0,
  cash_advance_fee_min_paisa      INTEGER DEFAULT 50000,
  fx_markup_pct                   REAL DEFAULT 3.5,
  reward_type                     TEXT DEFAULT 'none',
  reward_rate_pct                 REAL DEFAULT 0.0,
  minimum_payment_pct             REAL DEFAULT 5.0,
  minimum_payment_fixed_paisa     INTEGER DEFAULT 0,
  interest_free_days              INTEGER DEFAULT 55,
  default_statement_day           INTEGER DEFAULT 12,
  default_payment_due_day         INTEGER DEFAULT 25,
  late_payment_fee_paisa          INTEGER DEFAULT 150000,
  over_limit_fee_paisa            INTEGER DEFAULT 150000,
  annual_fee_waiver_spend_paisa   INTEGER DEFAULT 0,
  notes                           TEXT,
  created_at                      TEXT DEFAULT (datetime('now'))
);

-- ─── 2. credit_cards ─────────────────────────────────────────────────────────
-- One row per credit card entity. Linked to accounts.id via account_id.
-- Includes all appendix fields (A1, A3, A4, A5, A8, A12) per PART D contract spec.

CREATE TABLE IF NOT EXISTS credit_cards (
  id                              TEXT PRIMARY KEY,
  account_id                      TEXT NOT NULL,
  user_id                         TEXT NOT NULL DEFAULT 'user_owner',
  household_id                    TEXT NOT NULL DEFAULT 'hh_owner',
  bank_id                         TEXT,
  card_name                       TEXT,
  card_nickname                   TEXT,
  card_number_last4               TEXT,
  card_network                    TEXT DEFAULT 'visa',
  credit_limit_paisa              INTEGER NOT NULL DEFAULT 0,
  statement_day                   INTEGER NOT NULL DEFAULT 12,
  payment_due_day                 INTEGER NOT NULL DEFAULT 25,
  interest_free_days              INTEGER NOT NULL DEFAULT 55,
  apr_pct                         REAL DEFAULT 42.0,
  cash_advance_apr_pct            REAL DEFAULT 42.0,
  cash_advance_fee_pct            REAL DEFAULT 3.0,
  cash_advance_fee_min_paisa      INTEGER DEFAULT 50000,
  fx_markup_pct                   REAL DEFAULT 3.5,
  reward_type                     TEXT DEFAULT 'none',
  reward_rate_pct                 REAL DEFAULT 0.0,
  reward_cap_monthly_paisa        INTEGER,
  minimum_payment_pct             REAL DEFAULT 5.0,
  minimum_payment_fixed_paisa     INTEGER DEFAULT 0,
  annual_fee_paisa                INTEGER DEFAULT 0,
  annual_fee_month                INTEGER DEFAULT 1,
  late_payment_fee_paisa          INTEGER DEFAULT 150000,
  over_limit_fee_paisa            INTEGER DEFAULT 150000,
  auto_pay_enabled                INTEGER DEFAULT 0,
  auto_pay_amount_type            TEXT DEFAULT 'minimum',
  auto_pay_fixed_amount_paisa     INTEGER DEFAULT 0,
  auto_pay_account_id             TEXT,
  status                          TEXT NOT NULL DEFAULT 'active',
  backfill_status                 TEXT DEFAULT 'pending_user_confirm',
  opened_date                     TEXT,
  closed_date                     TEXT,
  notes                           TEXT,
  created_at                      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                      TEXT NOT NULL DEFAULT (datetime('now')),
  -- Appendix A1: PDF password handling
  pdf_password_strategy           TEXT DEFAULT 'manual_unlock',
  pdf_password_encrypted          TEXT,
  pdf_password_pattern            TEXT,
  email_forward_address           TEXT,
  -- Payment allocation order
  payment_allocation_order        TEXT DEFAULT 'bank_standard',
  -- Appendix A3: Auto-pay extended config
  auto_pay_fallback_to_minimum    INTEGER DEFAULT 1,
  auto_pay_backup_account_id      TEXT,
  auto_pay_max_retries            INTEGER DEFAULT 3,
  -- Appendix A4: Credit balance handling
  credit_balance_handling         TEXT DEFAULT 'apply_next_month',
  -- Appendix A5: Card succession (upgrade/replacement tracking)
  predecessor_card_id             TEXT,
  successor_card_id               TEXT,
  -- Appendix A8: Annual fee waiver eligibility
  waiver_threshold_period_months  INTEGER DEFAULT 12,
  -- Appendix A12: Multi-currency billing
  multi_currency_billing          INTEGER DEFAULT 0
);

-- ─── 3. card_statements ──────────────────────────────────────────────────────
-- One row per billing cycle per card. Includes PART C payment allocation fields.

CREATE TABLE IF NOT EXISTS card_statements (
  id                              TEXT PRIMARY KEY,
  card_id                         TEXT NOT NULL,
  user_id                         TEXT NOT NULL DEFAULT 'user_owner',
  statement_month                 TEXT NOT NULL,
  statement_start                 TEXT NOT NULL,
  statement_end                   TEXT NOT NULL,
  due_date                        TEXT NOT NULL,
  opening_balance_paisa           INTEGER DEFAULT 0,
  closing_balance_paisa           INTEGER DEFAULT 0,
  total_spend_paisa               INTEGER DEFAULT 0,
  total_payments_paisa            INTEGER DEFAULT 0,
  total_fees_paisa                INTEGER DEFAULT 0,
  total_interest_paisa            INTEGER DEFAULT 0,
  total_cashback_paisa            INTEGER DEFAULT 0,
  minimum_payment_paisa           INTEGER DEFAULT 0,
  statement_balance_paisa         INTEGER DEFAULT 0,
  paid_amount_paisa               INTEGER DEFAULT 0,
  payment_status                  TEXT DEFAULT 'unpaid',
  file_url                        TEXT,
  parsing_status                  TEXT DEFAULT 'none',
  source                          TEXT DEFAULT 'manual',
  reconciliation_status           TEXT DEFAULT 'unreconciled',
  created_at                      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                      TEXT NOT NULL DEFAULT (datetime('now')),
  -- PART C: Payment allocation tracking
  balance_remaining_paisa         INTEGER,
  total_allocations_paisa         INTEGER DEFAULT 0,
  late_payment_flagged            INTEGER DEFAULT 0,
  late_payment_date               TEXT,
  dispute_status                  TEXT DEFAULT 'none',
  dispute_amount_paisa            INTEGER DEFAULT 0,
  dispute_filed_date              TEXT,
  dispute_notes                   TEXT
);

-- ─── 4. card_statement_transactions ──────────────────────────────────────────
-- Junction table linking transactions to statements during reconciliation.

CREATE TABLE IF NOT EXISTS card_statement_transactions (
  id                  TEXT PRIMARY KEY,
  statement_id        TEXT NOT NULL,
  transaction_id      TEXT NOT NULL,
  card_id             TEXT NOT NULL,
  user_id             TEXT NOT NULL DEFAULT 'user_owner',
  match_type          TEXT DEFAULT 'auto',
  match_confidence    REAL DEFAULT 1.0,
  matched_at          TEXT DEFAULT (datetime('now')),
  notes               TEXT
);

-- ─── 5. card_interest_accruals ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS card_interest_accruals (
  id                              TEXT PRIMARY KEY,
  card_id                         TEXT NOT NULL,
  user_id                         TEXT NOT NULL DEFAULT 'user_owner',
  statement_id                    TEXT,
  transaction_id                  TEXT,
  accrual_date                    TEXT NOT NULL,
  accrual_type                    TEXT NOT NULL DEFAULT 'purchase_interest',
  period_start                    TEXT,
  period_end                      TEXT,
  average_daily_balance_paisa     INTEGER DEFAULT 0,
  daily_rate                      REAL DEFAULT 0.0,
  days                            INTEGER DEFAULT 0,
  amount_paisa                    INTEGER NOT NULL DEFAULT 0,
  capitalized                     INTEGER DEFAULT 0,
  notes                           TEXT,
  created_at                      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─── 6. card_fees ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS card_fees (
  id              TEXT PRIMARY KEY,
  card_id         TEXT NOT NULL,
  user_id         TEXT NOT NULL DEFAULT 'user_owner',
  transaction_id  TEXT,
  fee_type        TEXT NOT NULL,
  amount_paisa    INTEGER NOT NULL DEFAULT 0,
  fee_date        TEXT NOT NULL,
  waived          INTEGER DEFAULT 0,
  waiver_reason   TEXT,
  statement_id    TEXT,
  notes           TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─── 7. card_reconciliation_sessions ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS card_reconciliation_sessions (
  id                      TEXT PRIMARY KEY,
  card_id                 TEXT NOT NULL,
  user_id                 TEXT NOT NULL DEFAULT 'user_owner',
  statement_id            TEXT NOT NULL,
  status                  TEXT NOT NULL DEFAULT 'in_progress',
  total_statement_txns    INTEGER DEFAULT 0,
  matched_count           INTEGER DEFAULT 0,
  unmatched_count         INTEGER DEFAULT 0,
  new_txns_created        INTEGER DEFAULT 0,
  started_at              TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at            TEXT,
  notes                   TEXT
);

-- ─── 8. installment_plans (Appendix A2) ──────────────────────────────────────

CREATE TABLE IF NOT EXISTS installment_plans (
  id                          TEXT PRIMARY KEY,
  card_id                     TEXT NOT NULL,
  user_id                     TEXT NOT NULL DEFAULT 'user_owner',
  original_transaction_id     TEXT NOT NULL,
  total_amount_paisa          INTEGER NOT NULL,
  installment_count           INTEGER NOT NULL,
  installment_amount_paisa    INTEGER NOT NULL,
  processing_fee_paisa        INTEGER DEFAULT 0,
  apr_pct                     REAL DEFAULT 0.0,
  start_date                  TEXT NOT NULL,
  end_date                    TEXT,
  status                      TEXT NOT NULL DEFAULT 'active',
  bank_reference              TEXT,
  next_installment_date       TEXT,
  installments_paid           INTEGER DEFAULT 0,
  created_at                  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─── 9. card_subscriptions (Appendix A6) ─────────────────────────────────────

CREATE TABLE IF NOT EXISTS card_subscriptions (
  id                          TEXT PRIMARY KEY,
  card_id                     TEXT NOT NULL,
  user_id                     TEXT NOT NULL DEFAULT 'user_owner',
  merchant_pattern            TEXT NOT NULL,
  merchant_name               TEXT,
  amount_paisa                INTEGER,
  amount_tolerance_paisa      INTEGER DEFAULT 10000,
  currency                    TEXT DEFAULT 'PKR',
  frequency                   TEXT NOT NULL DEFAULT 'monthly',
  first_seen_date             TEXT,
  last_seen_date              TEXT,
  expected_next_date          TEXT,
  status                      TEXT NOT NULL DEFAULT 'active',
  category_id                 TEXT,
  auto_categorize             INTEGER DEFAULT 1,
  notes                       TEXT,
  created_at                  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─── 10. card_disputes (Appendix A14) ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS card_disputes (
  id                              TEXT PRIMARY KEY,
  card_id                         TEXT NOT NULL,
  user_id                         TEXT NOT NULL DEFAULT 'user_owner',
  transaction_id                  TEXT,
  statement_id                    TEXT,
  dispute_type                    TEXT NOT NULL DEFAULT 'unauthorized',
  amount_paisa                    INTEGER NOT NULL,
  filed_date                      TEXT NOT NULL,
  status                          TEXT NOT NULL DEFAULT 'filed',
  bank_reference                  TEXT,
  resolution_date                 TEXT,
  resolution_outcome              TEXT,
  resolution_notes                TEXT,
  provisional_credit_issued       INTEGER DEFAULT 0,
  provisional_credit_paisa        INTEGER DEFAULT 0,
  provisional_credit_date         TEXT,
  notes                           TEXT,
  created_at                      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─── 11. card_dispute_evidence (Appendix A14) ────────────────────────────────

CREATE TABLE IF NOT EXISTS card_dispute_evidence (
  id              TEXT PRIMARY KEY,
  dispute_id      TEXT NOT NULL,
  user_id         TEXT NOT NULL DEFAULT 'user_owner',
  evidence_type   TEXT NOT NULL,
  file_url        TEXT,
  description     TEXT,
  submitted_date  TEXT NOT NULL DEFAULT (datetime('now')),
  notes           TEXT
);

-- ─── 12. card_benefit_usage (Appendix A18) ───────────────────────────────────

CREATE TABLE IF NOT EXISTS card_benefit_usage (
  id              TEXT PRIMARY KEY,
  card_id         TEXT NOT NULL,
  user_id         TEXT NOT NULL DEFAULT 'user_owner',
  benefit_type    TEXT NOT NULL,
  amount_paisa    INTEGER DEFAULT 0,
  usage_date      TEXT NOT NULL,
  transaction_id  TEXT,
  description     TEXT,
  status          TEXT DEFAULT 'used',
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─── 13. household_members (Appendix A20) ────────────────────────────────────

CREATE TABLE IF NOT EXISTS household_members (
  id                      TEXT PRIMARY KEY,
  card_id                 TEXT NOT NULL,
  user_id                 TEXT NOT NULL DEFAULT 'user_owner',
  member_name             TEXT NOT NULL,
  relationship            TEXT,
  card_number_last4       TEXT,
  spending_limit_paisa    INTEGER,
  status                  TEXT NOT NULL DEFAULT 'active',
  added_date              TEXT NOT NULL DEFAULT (datetime('now')),
  notes                   TEXT
);

-- ─── 14. household_member_charges (Appendix A20) ─────────────────────────────

CREATE TABLE IF NOT EXISTS household_member_charges (
  id              TEXT PRIMARY KEY,
  member_id       TEXT NOT NULL,
  card_id         TEXT NOT NULL,
  user_id         TEXT NOT NULL DEFAULT 'user_owner',
  transaction_id  TEXT NOT NULL,
  amount_paisa    INTEGER NOT NULL,
  charge_date     TEXT NOT NULL,
  settled         INTEGER DEFAULT 0,
  settlement_id   TEXT,
  notes           TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─── 15. household_settlements (Appendix A20) ────────────────────────────────

CREATE TABLE IF NOT EXISTS household_settlements (
  id                  TEXT PRIMARY KEY,
  card_id             TEXT NOT NULL,
  user_id             TEXT NOT NULL DEFAULT 'user_owner',
  period_start        TEXT NOT NULL,
  period_end          TEXT NOT NULL,
  total_amount_paisa  INTEGER NOT NULL DEFAULT 0,
  status              TEXT NOT NULL DEFAULT 'pending',
  settled_date        TEXT,
  notes               TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─── 16. household_settlement_items (Appendix A20) ───────────────────────────

CREATE TABLE IF NOT EXISTS household_settlement_items (
  id              TEXT PRIMARY KEY,
  settlement_id   TEXT NOT NULL,
  member_id       TEXT NOT NULL,
  charge_id       TEXT NOT NULL,
  amount_paisa    INTEGER NOT NULL,
  notes           TEXT
);

-- ─── 17. card_trips (Appendix A17) ───────────────────────────────────────────

CREATE TABLE IF NOT EXISTS card_trips (
  id              TEXT PRIMARY KEY,
  card_id         TEXT NOT NULL,
  user_id         TEXT NOT NULL DEFAULT 'user_owner',
  trip_name       TEXT NOT NULL,
  destination     TEXT,
  departure_date  TEXT NOT NULL,
  return_date     TEXT,
  budget_paisa    INTEGER DEFAULT 0,
  spent_paisa     INTEGER DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'planned',
  notes           TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─── 18. card_savings_goals (Appendix A10) ───────────────────────────────────

CREATE TABLE IF NOT EXISTS card_savings_goals (
  id                          TEXT PRIMARY KEY,
  card_id                     TEXT NOT NULL,
  user_id                     TEXT NOT NULL DEFAULT 'user_owner',
  goal_name                   TEXT NOT NULL,
  target_amount_paisa         INTEGER NOT NULL,
  saved_amount_paisa          INTEGER DEFAULT 0,
  cashback_allocated_paisa    INTEGER DEFAULT 0,
  target_date                 TEXT,
  status                      TEXT NOT NULL DEFAULT 'active',
  notes                       TEXT,
  created_at                  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─── 19. notification_log (Appendix A7) ──────────────────────────────────────

CREATE TABLE IF NOT EXISTS notification_log (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL DEFAULT 'user_owner',
  card_id             TEXT,
  notification_type   TEXT NOT NULL,
  title               TEXT,
  body                TEXT,
  data                TEXT,
  channel             TEXT DEFAULT 'in_app',
  status              TEXT DEFAULT 'pending',
  sent_at             TEXT,
  read_at             TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─── 20. cron_execution_log (Appendix A27) ───────────────────────────────────

CREATE TABLE IF NOT EXISTS cron_execution_log (
  id                  TEXT PRIMARY KEY,
  job_name            TEXT NOT NULL,
  started_at          TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at        TEXT,
  status              TEXT NOT NULL DEFAULT 'running',
  records_processed   INTEGER DEFAULT 0,
  error_message       TEXT,
  notes               TEXT
);

-- ═══════════════════════════════════════════
-- PART B: EXTEND TRANSACTIONS TABLE
-- All ADD COLUMN are nullable or have DEFAULT (D1 ALTER TABLE constraint)
-- cc_subtype: purchase/cash_advance/intl/payment/interest/fee/refund/balance_transfer/bill_payment/emi_installment/dispute_credit
-- ═══════════════════════════════════════════

ALTER TABLE transactions ADD COLUMN cc_subtype TEXT;
ALTER TABLE transactions ADD COLUMN cc_statement_id TEXT;
ALTER TABLE transactions ADD COLUMN cc_reconciliation_status TEXT DEFAULT 'unreconciled';
ALTER TABLE transactions ADD COLUMN payment_allocation TEXT;
ALTER TABLE transactions ADD COLUMN reward_earned_paisa INTEGER;
ALTER TABLE transactions ADD COLUMN reward_earned_points REAL;
ALTER TABLE transactions ADD COLUMN reward_earned_miles REAL;
ALTER TABLE transactions ADD COLUMN household_member_id TEXT;
ALTER TABLE transactions ADD COLUMN bill_payment_type TEXT;
ALTER TABLE transactions ADD COLUMN bill_payment_provider TEXT;
ALTER TABLE transactions ADD COLUMN bill_reference_number TEXT;
ALTER TABLE transactions ADD COLUMN trip_id TEXT;
ALTER TABLE transactions ADD COLUMN benefit_usage_id TEXT;
ALTER TABLE transactions ADD COLUMN tax_deductible_business INTEGER DEFAULT 0;
ALTER TABLE transactions ADD COLUMN tax_category TEXT;

-- ═══════════════════════════════════════════
-- PART E: SEED bank_card_defaults — 15 Pakistani banks
-- INSERT OR REPLACE = upsert; safe to re-run
-- Amounts in paisa (100 paisa = 1 PKR):
--   150000 paisa = PKR 1,500
--   200000 paisa = PKR 2,000
--   50000 paisa  = PKR 500 (min cash advance fee)
-- IFD = interest-free days (from statement cut to payment due)
-- ═══════════════════════════════════════════

INSERT OR REPLACE INTO bank_card_defaults (bank_id, bank_name, apr_pct, cash_advance_apr_pct, cash_advance_fee_pct, cash_advance_fee_min_paisa, fx_markup_pct, reward_type, reward_rate_pct, minimum_payment_pct, minimum_payment_fixed_paisa, interest_free_days, default_statement_day, default_payment_due_day, late_payment_fee_paisa, over_limit_fee_paisa, notes)
VALUES
  ('faysal',      'Faysal Bank',                  42.0, 42.0, 3.0, 50000, 3.5, 'cashback', 1.0, 5.0, 0, 50, 12, 5,  150000, 150000, 'Islamic + conventional; 50-day IFD; cashback on eligible spends'),
  ('js',          'JS Bank',                      42.0, 42.0, 3.0, 50000, 3.5, 'points',   1.0, 5.0, 0, 50, 12, 5,  150000, 150000, 'Visa/Mastercard; JS Rewards Points program'),
  ('ubl',         'United Bank Limited',          42.0, 42.0, 3.0, 50000, 3.5, 'cashback', 1.5, 5.0, 0, 55, 12, 5,  150000, 150000, 'UBL Cashback/Rewards; 55-day IFD; 1.5% cashback'),
  ('hbl',         'Habib Bank Limited',           40.0, 40.0, 3.0, 50000, 3.0, 'points',   1.0, 5.0, 0, 55, 12, 5,  150000, 150000, 'HBL Credit Cards; largest branch network; HBL Rewards'),
  ('alfalah',     'Bank Alfalah',                 42.0, 42.0, 3.0, 50000, 3.5, 'cashback', 1.0, 5.0, 0, 55, 12, 5,  150000, 150000, 'Alfalah Cashback; Alfa Rewards; 55-day IFD'),
  ('meezan',      'Meezan Bank',                   0.0,  0.0, 3.0, 50000, 3.5, 'none',     0.0, 5.0, 0, 50, 12, 5,  150000, 150000, 'Islamic card; no riba interest; profit-based billing only'),
  ('mcb',         'MCB Bank',                     42.0, 42.0, 3.0, 50000, 3.5, 'points',   1.0, 5.0, 0, 55, 12, 5,  150000, 150000, 'MCB Lite/Signature/Titanium; MCB Reward Points'),
  ('scb',         'Standard Chartered Pakistan',  38.0, 38.0, 3.0, 50000, 3.5, 'miles',    2.0, 5.0, 0, 55, 12, 5,  200000, 200000, 'SC Pakistan; premium travel rewards; higher fees; 38% APR'),
  ('habib_metro', 'Habib Metropolitan Bank',      42.0, 42.0, 3.0, 50000, 3.5, 'points',   1.0, 5.0, 0, 55, 12, 5,  150000, 150000, 'HabibMetro Classic/Gold/Platinum; Habibi Rewards'),
  ('nbp',         'National Bank of Pakistan',    36.0, 36.0, 3.0, 50000, 3.5, 'none',     0.0, 5.0, 0, 45, 12, 5,  100000, 100000, 'NBP state bank; lower APR; basic product; 45-day IFD'),
  ('abl',         'Allied Bank Limited',          40.0, 40.0, 3.0, 50000, 3.5, 'cashback', 1.0, 5.0, 0, 50, 12, 5,  150000, 150000, 'ABL Visa/Mastercard; Allied Reward Points; cashback variant'),
  ('bank_al_habib','Bank Al-Habib',               40.0, 40.0, 3.0, 50000, 3.5, 'points',   1.0, 5.0, 0, 50, 12, 5,  150000, 150000, 'BAHL Cards; extensive branch network; BAHL Rewards'),
  ('silk_bank',   'Silk Bank',                    42.0, 42.0, 3.5, 50000, 3.5, 'cashback', 1.0, 5.0, 0, 45, 12, 5,  150000, 150000, 'Silk Signature/Platinum; cashback focus; 45-day IFD'),
  ('dib',         'Dubai Islamic Bank Pakistan',   0.0,  0.0, 3.0, 50000, 3.5, 'none',     0.0, 5.0, 0, 50, 12, 5,  150000, 150000, 'Islamic finance; profit-based billing; no riba; DIB Pakistan'),
  ('askari',      'Askari Bank',                  42.0, 42.0, 3.0, 50000, 3.5, 'points',   1.0, 5.0, 0, 50, 12, 5,  150000, 150000, 'Askari Classic/Gold/Platinum; military banking heritage; ARewards');

-- ═══════════════════════════════════════════
-- PART F: BACKFILL EXISTING CC ACCOUNTS (A25 hybrid strategy)
-- Inserts credit_cards rows for every accounts row where kind='cc'.
-- Auto-detects bank_id from account name pattern.
-- Pulls defaults from bank_card_defaults via sub-select.
-- backfill_status='pending_user_confirm' — user must verify before activating full CC features.
-- INSERT OR IGNORE = safe to re-run without duplicating.
-- ═══════════════════════════════════════════

INSERT OR IGNORE INTO credit_cards (
  id,
  account_id,
  user_id,
  household_id,
  bank_id,
  card_name,
  credit_limit_paisa,
  statement_day,
  payment_due_day,
  interest_free_days,
  apr_pct,
  cash_advance_apr_pct,
  cash_advance_fee_pct,
  cash_advance_fee_min_paisa,
  fx_markup_pct,
  reward_type,
  reward_rate_pct,
  minimum_payment_pct,
  late_payment_fee_paisa,
  over_limit_fee_paisa,
  status,
  backfill_status,
  created_at,
  updated_at
)
SELECT
  'cc_' || a.id                                                    AS id,
  a.id                                                             AS account_id,
  COALESCE(a.owner_user_id, 'user_owner')                          AS user_id,
  COALESCE(a.household_id,  'hh_owner')                           AS household_id,
  CASE
    WHEN LOWER(a.name) LIKE '%faysal%'  THEN 'faysal'
    WHEN LOWER(a.name) LIKE '%js%'      THEN 'js'
    WHEN LOWER(a.name) LIKE '%ubl%'     THEN 'ubl'
    WHEN LOWER(a.name) LIKE '%hbl%'     THEN 'hbl'
    WHEN LOWER(a.name) LIKE '%alfalah%' THEN 'alfalah'
    WHEN LOWER(a.name) LIKE '%meezan%'  THEN 'meezan'
    WHEN LOWER(a.name) LIKE '%mcb%'     THEN 'mcb'
    WHEN LOWER(a.name) LIKE '%scb%' OR LOWER(a.name) LIKE '%standard%' THEN 'scb'
    WHEN LOWER(a.name) LIKE '%habib%'   THEN 'habib_metro'
    WHEN LOWER(a.name) LIKE '%nbp%'     THEN 'nbp'
    WHEN LOWER(a.name) LIKE '%abl%' OR LOWER(a.name) LIKE '%allied%' THEN 'abl'
    WHEN LOWER(a.name) LIKE '%silk%'    THEN 'silk_bank'
    WHEN LOWER(a.name) LIKE '%askari%'  THEN 'askari'
    WHEN LOWER(a.name) LIKE '%dib%' OR LOWER(a.name) LIKE '%dubai%' THEN 'dib'
    ELSE NULL
  END                                                              AS bank_id,
  a.name                                                           AS card_name,
  COALESCE(
    a.credit_limit_paisa,
    CAST(ROUND(COALESCE(a.credit_limit, 0) * 100) AS INTEGER)
  )                                                                AS credit_limit_paisa,
  COALESCE(a.statement_day,    bcd.default_statement_day,    12)  AS statement_day,
  COALESCE(a.payment_due_day,  bcd.default_payment_due_day,  25)  AS payment_due_day,
  COALESCE(bcd.interest_free_days, 55)                            AS interest_free_days,
  COALESCE(bcd.apr_pct,             42.0)                         AS apr_pct,
  COALESCE(bcd.cash_advance_apr_pct, 42.0)                        AS cash_advance_apr_pct,
  COALESCE(bcd.cash_advance_fee_pct, 3.0)                         AS cash_advance_fee_pct,
  COALESCE(bcd.cash_advance_fee_min_paisa, 50000)                 AS cash_advance_fee_min_paisa,
  COALESCE(bcd.fx_markup_pct,  3.5)                               AS fx_markup_pct,
  COALESCE(bcd.reward_type,    'none')                            AS reward_type,
  COALESCE(bcd.reward_rate_pct, 0.0)                              AS reward_rate_pct,
  COALESCE(bcd.minimum_payment_pct, 5.0)                          AS minimum_payment_pct,
  COALESCE(bcd.late_payment_fee_paisa, 150000)                    AS late_payment_fee_paisa,
  COALESCE(bcd.over_limit_fee_paisa,   150000)                    AS over_limit_fee_paisa,
  COALESCE(a.status, 'active')                                    AS status,
  'pending_user_confirm'                                           AS backfill_status,
  COALESCE(a.created_at, datetime('now'))                         AS created_at,
  datetime('now')                                                  AS updated_at
FROM accounts a
LEFT JOIN bank_card_defaults bcd ON bcd.bank_id = CASE
    WHEN LOWER(a.name) LIKE '%faysal%'  THEN 'faysal'
    WHEN LOWER(a.name) LIKE '%js%'      THEN 'js'
    WHEN LOWER(a.name) LIKE '%ubl%'     THEN 'ubl'
    WHEN LOWER(a.name) LIKE '%hbl%'     THEN 'hbl'
    WHEN LOWER(a.name) LIKE '%alfalah%' THEN 'alfalah'
    WHEN LOWER(a.name) LIKE '%meezan%'  THEN 'meezan'
    WHEN LOWER(a.name) LIKE '%mcb%'     THEN 'mcb'
    WHEN LOWER(a.name) LIKE '%scb%' OR LOWER(a.name) LIKE '%standard%' THEN 'scb'
    WHEN LOWER(a.name) LIKE '%habib%'   THEN 'habib_metro'
    WHEN LOWER(a.name) LIKE '%nbp%'     THEN 'nbp'
    WHEN LOWER(a.name) LIKE '%abl%' OR LOWER(a.name) LIKE '%allied%' THEN 'abl'
    WHEN LOWER(a.name) LIKE '%silk%'    THEN 'silk_bank'
    WHEN LOWER(a.name) LIKE '%askari%'  THEN 'askari'
    WHEN LOWER(a.name) LIKE '%dib%' OR LOWER(a.name) LIKE '%dubai%' THEN 'dib'
    ELSE NULL
  END
WHERE a.kind = 'cc'
  AND (a.deleted_at IS NULL OR a.deleted_at = '')
  AND (a.archived_at IS NULL OR a.archived_at = '');

-- ═══════════════════════════════════════════
-- PART G: INDEXES
-- ═══════════════════════════════════════════

CREATE INDEX IF NOT EXISTS idx_credit_cards_account_id     ON credit_cards(account_id);
CREATE INDEX IF NOT EXISTS idx_credit_cards_user_id        ON credit_cards(user_id);
CREATE INDEX IF NOT EXISTS idx_credit_cards_bank_id        ON credit_cards(bank_id);
CREATE INDEX IF NOT EXISTS idx_credit_cards_status         ON credit_cards(status);

CREATE INDEX IF NOT EXISTS idx_card_statements_card_id     ON card_statements(card_id);
CREATE INDEX IF NOT EXISTS idx_card_statements_user_id     ON card_statements(user_id);
CREATE INDEX IF NOT EXISTS idx_card_statements_month       ON card_statements(statement_month);
CREATE INDEX IF NOT EXISTS idx_card_statements_due_date    ON card_statements(due_date);
CREATE INDEX IF NOT EXISTS idx_card_statements_status      ON card_statements(payment_status);

CREATE INDEX IF NOT EXISTS idx_card_stmt_txns_stmt_id      ON card_statement_transactions(statement_id);
CREATE INDEX IF NOT EXISTS idx_card_stmt_txns_txn_id       ON card_statement_transactions(transaction_id);
CREATE INDEX IF NOT EXISTS idx_card_stmt_txns_card_id      ON card_statement_transactions(card_id);

CREATE INDEX IF NOT EXISTS idx_card_interest_card_id       ON card_interest_accruals(card_id);
CREATE INDEX IF NOT EXISTS idx_card_interest_stmt_id       ON card_interest_accruals(statement_id);
CREATE INDEX IF NOT EXISTS idx_card_interest_date          ON card_interest_accruals(accrual_date);

CREATE INDEX IF NOT EXISTS idx_card_fees_card_id           ON card_fees(card_id);
CREATE INDEX IF NOT EXISTS idx_card_fees_type              ON card_fees(fee_type);
CREATE INDEX IF NOT EXISTS idx_card_fees_date              ON card_fees(fee_date);

CREATE INDEX IF NOT EXISTS idx_recon_sessions_card_id      ON card_reconciliation_sessions(card_id);
CREATE INDEX IF NOT EXISTS idx_recon_sessions_stmt_id      ON card_reconciliation_sessions(statement_id);

CREATE INDEX IF NOT EXISTS idx_installment_card_id         ON installment_plans(card_id);
CREATE INDEX IF NOT EXISTS idx_installment_txn_id          ON installment_plans(original_transaction_id);
CREATE INDEX IF NOT EXISTS idx_installment_status          ON installment_plans(status);

CREATE INDEX IF NOT EXISTS idx_card_subs_card_id           ON card_subscriptions(card_id);
CREATE INDEX IF NOT EXISTS idx_card_subs_merchant          ON card_subscriptions(merchant_pattern);
CREATE INDEX IF NOT EXISTS idx_card_subs_status            ON card_subscriptions(status);

CREATE INDEX IF NOT EXISTS idx_card_disputes_card_id       ON card_disputes(card_id);
CREATE INDEX IF NOT EXISTS idx_card_disputes_txn_id        ON card_disputes(transaction_id);
CREATE INDEX IF NOT EXISTS idx_card_disputes_status        ON card_disputes(status);

CREATE INDEX IF NOT EXISTS idx_dispute_evidence_dispute_id ON card_dispute_evidence(dispute_id);

CREATE INDEX IF NOT EXISTS idx_benefit_usage_card_id       ON card_benefit_usage(card_id);
CREATE INDEX IF NOT EXISTS idx_benefit_usage_date          ON card_benefit_usage(usage_date);

CREATE INDEX IF NOT EXISTS idx_hh_members_card_id          ON household_members(card_id);
CREATE INDEX IF NOT EXISTS idx_hh_charges_member_id        ON household_member_charges(member_id);
CREATE INDEX IF NOT EXISTS idx_hh_charges_card_id          ON household_member_charges(card_id);
CREATE INDEX IF NOT EXISTS idx_hh_settlements_card_id      ON household_settlements(card_id);
CREATE INDEX IF NOT EXISTS idx_hh_settle_items_settle_id   ON household_settlement_items(settlement_id);

CREATE INDEX IF NOT EXISTS idx_card_trips_card_id          ON card_trips(card_id);
CREATE INDEX IF NOT EXISTS idx_card_trips_status           ON card_trips(status);

CREATE INDEX IF NOT EXISTS idx_card_goals_card_id          ON card_savings_goals(card_id);
CREATE INDEX IF NOT EXISTS idx_card_goals_status           ON card_savings_goals(status);

CREATE INDEX IF NOT EXISTS idx_notification_log_user_id    ON notification_log(user_id);
CREATE INDEX IF NOT EXISTS idx_notification_log_card_id    ON notification_log(card_id);
CREATE INDEX IF NOT EXISTS idx_notification_log_status     ON notification_log(status);
CREATE INDEX IF NOT EXISTS idx_notification_log_type       ON notification_log(notification_type);

CREATE INDEX IF NOT EXISTS idx_cron_log_job_name           ON cron_execution_log(job_name);
CREATE INDEX IF NOT EXISTS idx_cron_log_started            ON cron_execution_log(started_at);
CREATE INDEX IF NOT EXISTS idx_cron_log_status             ON cron_execution_log(status);

CREATE INDEX IF NOT EXISTS idx_tx_cc_subtype               ON transactions(cc_subtype)
  WHERE cc_subtype IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tx_cc_statement_id          ON transactions(cc_statement_id)
  WHERE cc_statement_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tx_trip_id                  ON transactions(trip_id)
  WHERE trip_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tx_household_member_id      ON transactions(household_member_id)
  WHERE household_member_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tx_cc_recon_status          ON transactions(cc_reconciliation_status)
  WHERE cc_reconciliation_status IS NOT NULL;

-- ═══════════════════════════════════════════
-- VERIFY (run after migration, separately):
-- SELECT COUNT(*) FROM credit_cards;                       -- should equal CC account count
-- SELECT COUNT(*) FROM bank_card_defaults;                 -- should be 15
-- PRAGMA table_info(transactions);                         -- verify new cc columns present
-- SELECT id, card_name, bank_id, backfill_status FROM credit_cards;
-- ═══════════════════════════════════════════
