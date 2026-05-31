-- Migration 25: Add card_tier column to credit_cards
-- MUTABLE_FIELDS in [[path]].js already includes card_tier but column was missing.
-- Nullable (no DEFAULT) so existing rows stay untouched.
-- Run: npx wrangler d1 execute sovereign-finance --remote --file=migrations/25_credit_cards_card_tier.sql

ALTER TABLE credit_cards ADD COLUMN card_tier TEXT;
