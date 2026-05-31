-- Migration 24: User preferences table
-- Run: wrangler d1 execute sovereign-finance --remote --command="CREATE TABLE IF NOT EXISTS user_preferences (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, theme TEXT NOT NULL DEFAULT 'dark', primary_currency TEXT NOT NULL DEFAULT 'PKR', date_format TEXT NOT NULL DEFAULT 'DD/MM/YYYY', week_start TEXT NOT NULL DEFAULT 'monday', privacy_mode INTEGER NOT NULL DEFAULT 0, compact_numbers INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL DEFAULT (datetime('now')))"

CREATE TABLE IF NOT EXISTS user_preferences (
  user_id          TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  theme            TEXT NOT NULL DEFAULT 'dark',
  primary_currency TEXT NOT NULL DEFAULT 'PKR',
  date_format      TEXT NOT NULL DEFAULT 'DD/MM/YYYY',
  week_start       TEXT NOT NULL DEFAULT 'monday',
  privacy_mode     INTEGER NOT NULL DEFAULT 0,
  compact_numbers  INTEGER NOT NULL DEFAULT 1,
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Verify:
-- SELECT name FROM sqlite_master WHERE type='table' AND name='user_preferences';
