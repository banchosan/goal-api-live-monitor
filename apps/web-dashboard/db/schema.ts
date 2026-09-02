export const monitorSchema = [
  `CREATE TABLE IF NOT EXISTS monitor_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    fixture_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    received_at TEXT NOT NULL,
    status TEXT,
    home TEXT,
    away TEXT,
    home_score TEXT,
    away_score TEXT,
    payload_json TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS monitor_events_fixture_time_idx ON monitor_events (fixture_id, received_at)',
  'CREATE INDEX IF NOT EXISTS monitor_events_session_idx ON monitor_events (session_id, id)',
] as const;
