/* Migration 12 — reconciliation_exceptions Phase 2 upgrade
 * reconciliation-v0.3
 *
 * Extends reconciliation_exceptions with commit-oriented columns.
 * Safe to run on a fresh database (IF NOT EXISTS) or a Phase 1 database
 * that already has the snapshot-based schema (ALTER TABLE ADD COLUMN).
 *
 * If a column already exists, SQLite will raise "duplicate column name".
 * When running via `wrangler d1 execute --file migrations/12_reconciliation_exceptions.sql`
 * on a Phase 1 database, those ALTER TABLE errors can be ignored — the
 * column is already present.
 */

-- Full table definition for fresh databases.
-- On existing Phase 1 databases this is a no-op (IF NOT EXISTS).
CREATE TABLE IF NOT EXISTS reconciliation_exceptions (
  id                       TEXT PRIMARY KEY,
  plan_id                  TEXT,
  account_id               TEXT,
  statement_transaction_id TEXT,
  ledger_transaction_id    TEXT,
  type                     TEXT,
  severity                 TEXT,
  amount                   REAL,
  description              TEXT,
  reason                   TEXT,
  recommended_action       TEXT,
  status                   TEXT DEFAULT 'open',
  created_at               TEXT,
  resolved_at              TEXT,
  resolution_note          TEXT
);

-- Additive column additions for Phase 1 → Phase 2 upgrade.
-- Each will fail with "duplicate column name" if the column already exists
-- (fresh databases created above already have them).  Safe to ignore.
ALTER TABLE reconciliation_exceptions ADD COLUMN plan_id TEXT;
ALTER TABLE reconciliation_exceptions ADD COLUMN statement_transaction_id TEXT;
ALTER TABLE reconciliation_exceptions ADD COLUMN ledger_transaction_id TEXT;
ALTER TABLE reconciliation_exceptions ADD COLUMN type TEXT;
ALTER TABLE reconciliation_exceptions ADD COLUMN severity TEXT;
ALTER TABLE reconciliation_exceptions ADD COLUMN amount REAL;
ALTER TABLE reconciliation_exceptions ADD COLUMN description TEXT;
ALTER TABLE reconciliation_exceptions ADD COLUMN reason TEXT;
ALTER TABLE reconciliation_exceptions ADD COLUMN recommended_action TEXT;
ALTER TABLE reconciliation_exceptions ADD COLUMN resolved_at TEXT;
ALTER TABLE reconciliation_exceptions ADD COLUMN resolution_note TEXT;

CREATE INDEX IF NOT EXISTS idx_recon_excp_status  ON reconciliation_exceptions(status);
CREATE INDEX IF NOT EXISTS idx_recon_excp_account ON reconciliation_exceptions(account_id);
CREATE INDEX IF NOT EXISTS idx_recon_excp_plan    ON reconciliation_exceptions(plan_id);
