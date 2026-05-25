-- Migration 13: Auth rate limiting table (additive)
-- Run: wrangler d1 execute sovereign-finance --file=migrations/13_auth_rate_limits.sql

CREATE TABLE IF NOT EXISTS auth_rate_limits (
  ip_address     TEXT NOT NULL,
  window_start   TEXT NOT NULL,
  attempt_count  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ip_address, window_start)
);

CREATE INDEX IF NOT EXISTS idx_auth_rate_limits_ip_window
  ON auth_rate_limits(ip_address, window_start DESC);

-- Verify:
-- SELECT name FROM sqlite_master WHERE type='table' AND name = 'auth_rate_limits';
