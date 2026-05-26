-- Migration 17: statement_files — R2-backed PDF upload tracker
-- Additive only. All new columns nullable or have DEFAULT.

CREATE TABLE IF NOT EXISTS statement_files (
  id                        TEXT PRIMARY KEY,
  user_id                   TEXT NOT NULL,
  account_id                TEXT NOT NULL,
  r2_key                    TEXT NOT NULL,
  original_filename         TEXT,
  content_type              TEXT,
  size_bytes                INTEGER,
  extraction_status         TEXT DEFAULT 'pending',
  extraction_result_json    TEXT,
  extracted_row_count       INTEGER,
  statement_import_id       TEXT,
  extraction_provider       TEXT DEFAULT 'gemini-1.5-flash',
  extraction_cost_cents     INTEGER DEFAULT 0,
  extraction_error          TEXT,
  detected_bank             TEXT,
  detected_currency         TEXT,
  detected_opening_balance  REAL,
  detected_closing_balance  REAL,
  detected_period_start     TEXT,
  detected_period_end       TEXT,
  deleted_at                TEXT,
  created_at                TEXT,
  extracted_at              TEXT
);

CREATE INDEX IF NOT EXISTS idx_stmt_files_user    ON statement_files(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stmt_files_account ON statement_files(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stmt_files_status  ON statement_files(extraction_status);
