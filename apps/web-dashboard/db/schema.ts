export const monitorSchema = [
  `CREATE TABLE IF NOT EXISTS upcoming_fixture_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    window_from TEXT NOT NULL,
    window_to TEXT NOT NULL,
    api_requests INTEGER NOT NULL,
    fixture_count INTEGER NOT NULL,
    fixtures_json TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS upcoming_fixture_runs_created_idx ON upcoming_fixture_runs (created_at DESC)',
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
  `CREATE TABLE IF NOT EXISTS form_analysis_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    checked_teams INTEGER NOT NULL,
    failed_teams INTEGER NOT NULL,
    api_requests INTEGER NOT NULL,
    candidates_json TEXT NOT NULL,
    checked_json TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS form_analysis_runs_created_idx ON form_analysis_runs (created_at DESC)',
  `CREATE TABLE IF NOT EXISTS odds_analysis_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL UNIQUE,
    form_run_id TEXT,
    created_at TEXT NOT NULL,
    api_requests INTEGER NOT NULL,
    matched_fixtures INTEGER NOT NULL,
    unmatched_json TEXT NOT NULL,
    fixtures_json TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS odds_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    api_fixture_id TEXT NOT NULL,
    kickoff TEXT,
    home TEXT NOT NULL,
    away TEXT NOT NULL,
    raw_json TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS odds_snapshots_run_idx ON odds_snapshots (run_id, id)',
  `CREATE TABLE IF NOT EXISTS result_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    odds_run_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    api_requests INTEGER NOT NULL,
    raw_json TEXT NOT NULL,
    UNIQUE(odds_run_id, created_at)
  )`,
  'CREATE INDEX IF NOT EXISTS result_snapshots_run_idx ON result_snapshots (odds_run_id, created_at DESC)',
] as const;
