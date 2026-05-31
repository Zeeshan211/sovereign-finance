-- Seed: CC card metadata for 5 Pakistani credit cards
-- Run AFTER migration 25 (card_tier column must exist).
-- Identifies cards by account_id sub-select — no hardcoded UUIDs.
--
-- IFD formula: billing_cycle_days (30) + payment_due_day (offset)
--   Alfalah  55 IFD = 30 + 25  (statement day 15, ~10th of next month due)
--   UBL      55 IFD = 30 + 25  (statement day 12)
--   JS Bank  50 IFD = 30 + 20  (statement day 12, ~1st of next month due)
--   Faysal   50 IFD = 30 + 20  (statement day 12)
--
-- Annual fees (PKR paisa):
--   Alfalah Gold Visa     PKR 3,500 = 350000 paisa
--   UBL Visa              PKR 2,500 = 250000 paisa
--   JS Bank Visa          PKR 2,500 = 250000 paisa
--   Faysal Mastercard     PKR 2,500 = 250000 paisa
--
-- APR: SBP-capped 42% for all conventional cards (Circular No. 3 of 2023)
-- Cash advance APR: 42%   |   Forex markup: 3.5%   |   Late fee: PKR 1,500

-- ── 1. Alfalah CC (Visa Gold, last4 1349, limit PKR 100,000) ────────────────
UPDATE credit_cards
SET
  card_network              = 'visa',
  card_number_last4         = '1349',
  card_tier                 = 'Gold',
  bank_id                   = 'alfalah',
  statement_day             = 15,
  payment_due_day           = 25,
  interest_free_days        = 55,
  credit_limit_paisa        = 10000000,
  apr_pct                   = 42.0,
  cash_advance_apr_pct      = 42.0,
  cash_advance_fee_pct      = 3.0,
  cash_advance_fee_min_paisa= 50000,
  fx_markup_pct             = 3.5,
  annual_fee_paisa          = 350000,
  late_payment_fee_paisa    = 150000,
  minimum_payment_pct       = 5.0,
  backfill_status           = 'confirmed',
  updated_at                = datetime('now')
WHERE account_id = (
  SELECT id FROM accounts
  WHERE LOWER(name) LIKE '%alfalah%' AND kind = 'cc'
  LIMIT 1
);

-- ── 2. UBL CC (Visa, last4 2388) ────────────────────────────────────────────
UPDATE credit_cards
SET
  card_network              = 'visa',
  card_number_last4         = '2388',
  bank_id                   = 'ubl',
  statement_day             = 12,
  payment_due_day           = 25,
  interest_free_days        = 55,
  apr_pct                   = 42.0,
  cash_advance_apr_pct      = 42.0,
  cash_advance_fee_pct      = 3.0,
  cash_advance_fee_min_paisa= 50000,
  fx_markup_pct             = 3.5,
  annual_fee_paisa          = 250000,
  late_payment_fee_paisa    = 150000,
  minimum_payment_pct       = 5.0,
  backfill_status           = 'confirmed',
  updated_at                = datetime('now')
WHERE account_id = (
  SELECT id FROM accounts
  WHERE LOWER(name) LIKE '%ubl%' AND kind = 'cc'
  LIMIT 1
);

-- ── 3. JS Bank CC (Visa, last4 8025) ────────────────────────────────────────
UPDATE credit_cards
SET
  card_network              = 'visa',
  card_number_last4         = '8025',
  bank_id                   = 'js',
  statement_day             = 12,
  payment_due_day           = 20,
  interest_free_days        = 50,
  apr_pct                   = 42.0,
  cash_advance_apr_pct      = 42.0,
  cash_advance_fee_pct      = 3.0,
  cash_advance_fee_min_paisa= 50000,
  fx_markup_pct             = 3.5,
  annual_fee_paisa          = 250000,
  late_payment_fee_paisa    = 150000,
  minimum_payment_pct       = 5.0,
  backfill_status           = 'confirmed',
  updated_at                = datetime('now')
WHERE account_id = (
  SELECT id FROM accounts
  WHERE LOWER(name) LIKE '%js%' AND kind = 'cc'
  LIMIT 1
);

-- ── 4. Faysal A (Mastercard, last4 2256) — alphabetically first Faysal card ─
UPDATE credit_cards
SET
  card_network              = 'mastercard',
  card_number_last4         = '2256',
  bank_id                   = 'faysal',
  statement_day             = 12,
  payment_due_day           = 20,
  interest_free_days        = 50,
  apr_pct                   = 42.0,
  cash_advance_apr_pct      = 42.0,
  cash_advance_fee_pct      = 3.0,
  cash_advance_fee_min_paisa= 50000,
  fx_markup_pct             = 3.5,
  annual_fee_paisa          = 250000,
  late_payment_fee_paisa    = 150000,
  minimum_payment_pct       = 5.0,
  backfill_status           = 'confirmed',
  updated_at                = datetime('now')
WHERE account_id = (
  SELECT id FROM accounts
  WHERE LOWER(name) LIKE '%faysal%' AND kind = 'cc'
  ORDER BY name ASC LIMIT 1 OFFSET 0
);

-- ── 5. Faysal B (Mastercard, last4 5698) — alphabetically second Faysal card ─
UPDATE credit_cards
SET
  card_network              = 'mastercard',
  card_number_last4         = '5698',
  bank_id                   = 'faysal',
  statement_day             = 12,
  payment_due_day           = 20,
  interest_free_days        = 50,
  apr_pct                   = 42.0,
  cash_advance_apr_pct      = 42.0,
  cash_advance_fee_pct      = 3.0,
  cash_advance_fee_min_paisa= 50000,
  fx_markup_pct             = 3.5,
  annual_fee_paisa          = 250000,
  late_payment_fee_paisa    = 150000,
  minimum_payment_pct       = 5.0,
  backfill_status           = 'confirmed',
  updated_at                = datetime('now')
WHERE account_id = (
  SELECT id FROM accounts
  WHERE LOWER(name) LIKE '%faysal%' AND kind = 'cc'
  ORDER BY name ASC LIMIT 1 OFFSET 1
);

-- Verify results
SELECT id, card_name, card_network, card_number_last4, card_tier, bank_id,
       statement_day, payment_due_day, interest_free_days,
       credit_limit_paisa, apr_pct, annual_fee_paisa, backfill_status
FROM credit_cards
ORDER BY card_name;
