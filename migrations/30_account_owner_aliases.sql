-- Migration 30: account owner aliases (Phase 3 — reconciliation transfer detection)
-- Adds a nullable JSON-array column so the reconciliation matcher can recognize
-- a bank statement's counterparty name as one of the user's OWN accounts and
-- suggest a Transfer instead of Income/Expense.
-- Additive + nullable → backward-compatible, satisfies D1 ALTER TABLE rules.
-- Run: wrangler d1 execute sovereign-finance --remote --file=migrations/30_account_owner_aliases.sql

ALTER TABLE accounts ADD COLUMN owner_aliases TEXT;
-- Example value: ["Muhammad Zeeshan Nasir","M Zeeshan Nasir","ZEESHAN NASIR"]
