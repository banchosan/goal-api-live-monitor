CREATE TABLE fixture_bookmarks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fixture_id TEXT NOT NULL UNIQUE,
  home TEXT NOT NULL,
  away TEXT NOT NULL,
  league TEXT NOT NULL,
  country TEXT NOT NULL DEFAULT '',
  kickoff_utc TEXT NOT NULL,
  bookmarked_at TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT 'manual',
  related_team_id TEXT,
  related_team_name TEXT,
  status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'monitoring', 'finished', 'removed')),
  monitor_source TEXT NOT NULL DEFAULT 'bookmark',
  monitoring_started_at TEXT,
  finished_at TEXT,
  removed_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX fixture_bookmarks_status_kickoff_idx ON fixture_bookmarks (status, kickoff_utc);
