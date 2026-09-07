CREATE TABLE IF NOT EXISTS monitor_fixture_exclusions (
  fixture_id TEXT PRIMARY KEY,
  home TEXT NOT NULL DEFAULT '',
  away TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT 'manual_monitor_remove',
  active INTEGER NOT NULL DEFAULT 1,
  excluded_at TEXT NOT NULL,
  restored_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS monitor_fixture_exclusions_active_idx
  ON monitor_fixture_exclusions (active, updated_at DESC);
