-- Migration 28: categorization_rules — auto-categorization rules engine
-- Additive only. New table, all columns NOT NULL have explicit values or DEFAULT.
--
-- Run: wrangler d1 execute sovereign-finance --file=migrations/28_categorization_rules.sql --remote
-- Verify: wrangler d1 execute sovereign-finance --command="SELECT * FROM categorization_rules LIMIT 5" --remote

CREATE TABLE IF NOT EXISTS categorization_rules (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT NOT NULL,
  name                TEXT,
  match_field         TEXT NOT NULL,            -- 'merchant' | 'notes' | 'description'
  match_type          TEXT NOT NULL DEFAULT 'contains', -- 'contains' | 'exact' | 'starts_with'
  match_value         TEXT NOT NULL,
  target_category_id  TEXT NOT NULL,
  priority            INTEGER NOT NULL DEFAULT 0,
  is_active           INTEGER NOT NULL DEFAULT 1,
  times_applied       INTEGER NOT NULL DEFAULT 0,
  last_applied_at     TEXT,
  created_at          TEXT,
  updated_at          TEXT
);

CREATE INDEX IF NOT EXISTS idx_categorization_rules_user   ON categorization_rules(user_id, priority DESC);
CREATE INDEX IF NOT EXISTS idx_categorization_rules_active ON categorization_rules(user_id, is_active);
