-- Migration 27: Add onboarding_completed flag to user_preferences
-- Run: wrangler d1 execute sovereign-finance --remote --file=migrations/27_onboarding_completed.sql
-- Safe: ADD COLUMN with DEFAULT on existing table is backward-compatible.

ALTER TABLE user_preferences ADD COLUMN onboarding_completed INTEGER NOT NULL DEFAULT 0;

-- Verify:
-- SELECT user_id, onboarding_completed FROM user_preferences LIMIT 5;
