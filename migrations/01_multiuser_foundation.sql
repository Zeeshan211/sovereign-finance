-- Migration 01: Multi-user foundation tables
-- Run: wrangler d1 execute sovereign-finance --file=migrations/01_multiuser_foundation.sql
-- Safe to run once. Uses CREATE TABLE IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS households (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  owner_user_id TEXT NOT NULL,
  settings     TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  household_id  TEXT NOT NULL,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT,
  full_name     TEXT NOT NULL,
  display_name  TEXT,
  role          TEXT NOT NULL DEFAULT 'owner'
    CHECK(role IN ('owner', 'admin', 'member', 'view_only')),
  status        TEXT NOT NULL DEFAULT 'active'
    CHECK(status IN ('active', 'invited', 'suspended', 'deleted')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT,
  preferences   TEXT,
  FOREIGN KEY (household_id) REFERENCES households(id)
);

CREATE TABLE IF NOT EXISTS account_permissions (
  id                TEXT PRIMARY KEY,
  account_id        TEXT NOT NULL,
  user_id           TEXT NOT NULL,
  can_read          INTEGER NOT NULL DEFAULT 1,
  can_write         INTEGER NOT NULL DEFAULT 1,
  can_admin         INTEGER NOT NULL DEFAULT 0,
  granted_at        TEXT NOT NULL DEFAULT (datetime('now')),
  granted_by_user_id TEXT,
  FOREIGN KEY (account_id) REFERENCES accounts(id),
  FOREIGN KEY (user_id)    REFERENCES users(id),
  UNIQUE(account_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_users_household
  ON users(household_id);

CREATE INDEX IF NOT EXISTS idx_users_email
  ON users(email);

CREATE INDEX IF NOT EXISTS idx_account_perms_user
  ON account_permissions(user_id);

CREATE INDEX IF NOT EXISTS idx_account_perms_account
  ON account_permissions(account_id);

-- Seed default household and owner user (idempotent)
INSERT INTO households (id, name, owner_user_id)
  VALUES ('hh_owner', 'My Household', 'user_owner')
  ON CONFLICT DO NOTHING;

INSERT INTO users (id, household_id, email, full_name, role, status)
  VALUES ('user_owner', 'hh_owner', 'owner@local', 'Owner', 'owner', 'active')
  ON CONFLICT DO NOTHING;

-- Verify:
-- SELECT name FROM sqlite_master WHERE type='table' AND name IN ('households','users','account_permissions');
-- PRAGMA table_info(users);
