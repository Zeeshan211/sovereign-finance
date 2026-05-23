-- Migration 02: Auth foundation tables
-- Run: wrangler d1 execute sovereign-finance --file=migrations/02_auth_foundation.sql
-- Requires: 01_multiuser_foundation.sql (users table must exist)

CREATE TABLE IF NOT EXISTS sessions (
  id                   TEXT PRIMARY KEY,
  user_id              TEXT NOT NULL,
  token_hash           TEXT NOT NULL,
  refresh_token_hash   TEXT,
  device_label         TEXT,
  ip_address           TEXT,
  user_agent           TEXT,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  last_active_at       TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at           TEXT NOT NULL,
  revoked_at           TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS login_attempts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  email          TEXT,
  ip_address     TEXT,
  success        INTEGER NOT NULL DEFAULT 0,
  attempted_at   TEXT NOT NULL DEFAULT (datetime('now')),
  user_agent     TEXT,
  failure_reason TEXT
);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  used_at    TEXT,
  ip_address TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS user_2fa (
  user_id                  TEXT PRIMARY KEY,
  totp_secret_encrypted    TEXT,
  backup_codes_encrypted   TEXT,
  enabled_at               TEXT,
  last_used_at             TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_sessions_user
  ON sessions(user_id);

CREATE INDEX IF NOT EXISTS idx_sessions_token
  ON sessions(token_hash);

CREATE INDEX IF NOT EXISTS idx_sessions_expires
  ON sessions(expires_at);

CREATE INDEX IF NOT EXISTS idx_login_attempts_email_time
  ON login_attempts(email, attempted_at DESC);

CREATE INDEX IF NOT EXISTS idx_login_attempts_ip_time
  ON login_attempts(ip_address, attempted_at DESC);

CREATE INDEX IF NOT EXISTS idx_password_reset_user
  ON password_reset_tokens(user_id);

CREATE INDEX IF NOT EXISTS idx_password_reset_token
  ON password_reset_tokens(token_hash);

-- Verify:
-- SELECT name FROM sqlite_master WHERE type='table' AND name IN ('sessions','login_attempts','password_reset_tokens','user_2fa');
