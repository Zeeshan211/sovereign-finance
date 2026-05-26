-- 19_hub_dismissals.sql
-- Hub dismiss tables for priority inbox and insight dismissals

CREATE TABLE IF NOT EXISTS hub_dismissals (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  item_signature TEXT NOT NULL,
  dismissed_at TEXT,
  reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_hub_dismissals_user
  ON hub_dismissals(user_id, dismissed_at DESC);

CREATE TABLE IF NOT EXISTS hub_insight_dismissals (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  insight_signature TEXT NOT NULL,
  dismissed_at TEXT,
  reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_hub_insight_dismissals_user
  ON hub_insight_dismissals(user_id, dismissed_at DESC);

CREATE TABLE IF NOT EXISTS hub_snapshot_cache (
  user_id TEXT PRIMARY KEY,
  snapshot_json TEXT NOT NULL,
  generated_at TEXT NOT NULL
);
