-- Add override-token columns to transaction_dry_runs so the cache-backed
-- commit path can enforce the same overdraft/over-limit block that
-- /api/transactions already computes, instead of writing unconditionally.

ALTER TABLE transaction_dry_runs ADD COLUMN requires_override INTEGER NOT NULL DEFAULT 0;
ALTER TABLE transaction_dry_runs ADD COLUMN override_reason TEXT;
ALTER TABLE transaction_dry_runs ADD COLUMN override_token TEXT;
