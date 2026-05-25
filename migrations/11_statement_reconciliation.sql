-- Migration 11: Statement Reconciliation v0.2
-- Run: wrangler d1 execute sovereign-finance --file=migrations/11_statement_reconciliation.sql
-- OR apply via Cloudflare D1 Console: Dashboard > D1 > sovereign-finance > Console
--
-- Additive only — all tables use IF NOT EXISTS, all new columns nullable or with DEFAULT.
-- Safe to re-run.

-- Bank statement import sessions
CREATE TABLE IF NOT EXISTS statement_imports (
  id                        TEXT    PRIMARY KEY,
  account_id                TEXT    NOT NULL,
  imported_at               TEXT    NOT NULL,
  row_count                 INTEGER NOT NULL DEFAULT 0,
  date_from                 TEXT,
  date_to                   TEXT,
  statement_closing_balance REAL,
  raw_csv                   TEXT,
  created_by                TEXT    DEFAULT 'web',
  created_at                TEXT    DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_stmt_imports_account ON statement_imports(account_id);
CREATE INDEX IF NOT EXISTS idx_stmt_imports_created ON statement_imports(created_at);

-- Individual rows parsed from a bank statement CSV
CREATE TABLE IF NOT EXISTS statement_transactions (
  id              TEXT PRIMARY KEY,
  import_id       TEXT NOT NULL,
  account_id      TEXT NOT NULL,
  posted_date     TEXT NOT NULL,
  description     TEXT,
  debit           REAL,
  credit          REAL,
  balance         REAL,
  idempotency_key TEXT,
  created_at      TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_stmt_txn_idem
  ON statement_transactions(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_stmt_txn_account ON statement_transactions(account_id);
CREATE INDEX IF NOT EXISTS idx_stmt_txn_import  ON statement_transactions(import_id);
CREATE INDEX IF NOT EXISTS idx_stmt_txn_date    ON statement_transactions(posted_date);

-- Dry-run reconciliation plans (Phase 2 adds commit path)
CREATE TABLE IF NOT EXISTS reconciliation_plans (
  id           TEXT PRIMARY KEY,
  import_id    TEXT NOT NULL,
  account_id   TEXT NOT NULL,
  plan_json    TEXT NOT NULL,
  created_at   TEXT DEFAULT CURRENT_TIMESTAMP,
  committed_at TEXT,
  committed_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_recon_plan_import  ON reconciliation_plans(import_id);
CREATE INDEX IF NOT EXISTS idx_recon_plan_account ON reconciliation_plans(account_id);

-- Verify after running:
-- SELECT name FROM sqlite_master WHERE type='table' AND name IN ('statement_imports','statement_transactions','reconciliation_plans');
