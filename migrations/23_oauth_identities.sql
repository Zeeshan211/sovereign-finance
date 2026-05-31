-- Migration 23: OAuth identities table (Google Sign In, Apple Sign In)
-- Run: wrangler d1 execute sovereign-finance --remote --file=migrations/23_oauth_identities.sql

CREATE TABLE IF NOT EXISTS oauth_identities (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider      TEXT    NOT NULL,      -- 'google' | 'apple'
  provider_sub  TEXT    NOT NULL,      -- subject claim from the provider's ID token
  provider_email TEXT,                 -- email from provider (for linking reference)
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(provider, provider_sub)
);

CREATE INDEX IF NOT EXISTS idx_oauth_identities_user
  ON oauth_identities(user_id);

CREATE INDEX IF NOT EXISTS idx_oauth_identities_lookup
  ON oauth_identities(provider, provider_sub);

-- Verify:
-- SELECT name FROM sqlite_master WHERE type='table' AND name='oauth_identities';
