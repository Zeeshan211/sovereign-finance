-- Migration 08: Update intl_rate_config to FY2025-26 verified rates
-- Run: wrangler d1 execute sovereign-finance --file=migrations/08_intl_rate_config_data.sql

UPDATE intl_rate_config
  SET fx_fee_pct           = 4.5,
      excise_on_fx_fee_pct = 16.0,
      advance_tax_pct      = 5.0,
      pra_pct              = 5.0
  WHERE id = 1;

-- Verify:
-- SELECT id, fx_fee_pct, excise_on_fx_fee_pct, advance_tax_pct, pra_pct FROM intl_rate_config WHERE id = 1;
