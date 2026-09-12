// Canonical expected local schema.  This is consumed by the local-only
// migration/adoption tool; request handlers must not execute it as runtime DDL.
export const canonicalSchema = [
  `CREATE TABLE IF NOT EXISTS monitor_fixture_exclusions (
    fixture_id TEXT PRIMARY KEY,
    home TEXT NOT NULL DEFAULT '',
    away TEXT NOT NULL DEFAULT '',
    reason TEXT NOT NULL DEFAULT 'manual_monitor_remove',
    active INTEGER NOT NULL DEFAULT 1,
    excluded_at TEXT NOT NULL,
    restored_at TEXT,
    updated_at TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS monitor_fixture_exclusions_active_idx ON monitor_fixture_exclusions (active, updated_at DESC)',
  `CREATE TABLE IF NOT EXISTS fixture_bookmarks (
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
  )`,
  'CREATE UNIQUE INDEX IF NOT EXISTS fixture_bookmarks_fixture_idx ON fixture_bookmarks (fixture_id)',
  'CREATE INDEX IF NOT EXISTS fixture_bookmarks_status_kickoff_idx ON fixture_bookmarks (status, kickoff_utc)',
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
    payload_json TEXT NOT NULL,
    client_event_id TEXT,
    connection_id TEXT,
    sequence INTEGER,
    source TEXT NOT NULL DEFAULT 'browser',
    provider_timestamp TEXT,
    payload_hash TEXT,
    schema_version INTEGER NOT NULL DEFAULT 1
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
  // Additive data-platform migration. Legacy JSON-backed tables above stay readable.
  `CREATE TABLE IF NOT EXISTS core_leagues (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    country TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS core_teams (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    country TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS team_provider_ids (
    provider TEXT NOT NULL,
    external_team_id TEXT NOT NULL,
    team_id TEXT NOT NULL REFERENCES core_teams(id),
    provider_payload_json TEXT,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    PRIMARY KEY (provider, external_team_id),
    UNIQUE (team_id, provider, external_team_id)
  )`,
  'CREATE INDEX IF NOT EXISTS team_provider_team_idx ON team_provider_ids (team_id)',
  `CREATE TABLE IF NOT EXISTS core_fixtures (
    id TEXT PRIMARY KEY,
    kickoff_utc TEXT,
    home_team_id TEXT REFERENCES core_teams(id),
    away_team_id TEXT REFERENCES core_teams(id),
    league_id TEXT REFERENCES core_leagues(id),
    home_name TEXT NOT NULL,
    away_name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS fixture_provider_ids (
    provider TEXT NOT NULL,
    external_fixture_id TEXT NOT NULL,
    fixture_id TEXT NOT NULL REFERENCES core_fixtures(id),
    provider_payload_json TEXT,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    PRIMARY KEY (provider, external_fixture_id),
    UNIQUE (fixture_id, provider, external_fixture_id)
  )`,
  'CREATE INDEX IF NOT EXISTS core_fixtures_kickoff_idx ON core_fixtures (kickoff_utc)',
  'CREATE INDEX IF NOT EXISTS fixture_provider_fixture_idx ON fixture_provider_ids (fixture_id)',
  `CREATE TABLE IF NOT EXISTS prematch_form_observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    form_run_id TEXT NOT NULL REFERENCES form_analysis_runs(run_id),
    provider TEXT NOT NULL,
    external_team_id TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    status TEXT NOT NULL,
    wins INTEGER,
    draws INTEGER,
    played INTEGER,
    result_json TEXT NOT NULL,
    UNIQUE (form_run_id, provider, external_team_id)
  )`,
  'CREATE INDEX IF NOT EXISTS prematch_form_team_time_idx ON prematch_form_observations (provider, external_team_id, observed_at DESC)',
  `CREATE TABLE IF NOT EXISTS odds_capture_runs_v2 (
    id TEXT PRIMARY KEY,
    legacy_run_id TEXT UNIQUE REFERENCES odds_analysis_runs(run_id),
    provider TEXT NOT NULL,
    captured_at TEXT NOT NULL,
    api_requests INTEGER NOT NULL DEFAULT 0,
    raw_json TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS odds_market_values (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    capture_run_id TEXT NOT NULL REFERENCES odds_capture_runs_v2(id),
    fixture_id TEXT NOT NULL REFERENCES core_fixtures(id),
    bookmaker TEXT NOT NULL,
    market TEXT NOT NULL,
    period TEXT NOT NULL CHECK (period IN ('FULL_TIME', 'FIRST_HALF', 'SECOND_HALF')),
    stat_type TEXT NOT NULL CHECK (stat_type IN ('RESULT', 'GOALS', 'CORNERS')),
    side TEXT CHECK (side IN ('HOME', 'AWAY', 'DRAW', 'OVER', 'UNDER')),
    selection TEXT NOT NULL,
    line REAL,
    odds REAL NOT NULL,
    captured_at TEXT NOT NULL,
    raw_json TEXT NOT NULL,
    UNIQUE (capture_run_id, fixture_id, bookmaker, market, period, stat_type, side, selection, line, odds)
  )`,
  'CREATE INDEX IF NOT EXISTS odds_market_fixture_time_idx ON odds_market_values (fixture_id, captured_at DESC)',
  'CREATE INDEX IF NOT EXISTS odds_market_lookup_idx ON odds_market_values (market, selection, line, odds)',
  `CREATE TABLE IF NOT EXISTS match_results_v2 (
    fixture_id TEXT PRIMARY KEY REFERENCES core_fixtures(id),
    provider TEXT NOT NULL,
    provider_status TEXT,
    home_goals INTEGER,
    away_goals INTEGER,
    home_halftime_goals INTEGER,
    away_halftime_goals INTEGER,
    finalized_at TEXT,
    captured_at TEXT NOT NULL,
    raw_json TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS live_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fixture_id TEXT NOT NULL REFERENCES core_fixtures(id),
    session_id TEXT NOT NULL,
    source_client_event_id TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT 'goal-api',
    provider_fixture_id TEXT,
    provider_event_key TEXT NOT NULL,
    provider_timestamp TEXT,
    captured_at TEXT NOT NULL,
    elapsed_minute INTEGER,
    added_time INTEGER,
    match_status TEXT,
    home_score INTEGER,
    away_score INTEGER,
    shots_home REAL, shots_away REAL,
    shots_on_target_home REAL, shots_on_target_away REAL,
    corners_home REAL, corners_away REAL,
    attacks_home REAL, attacks_away REAL,
    dangerous_attacks_home REAL, dangerous_attacks_away REAL,
    possession_home REAL, possession_away REAL,
    yellow_cards_home REAL, yellow_cards_away REAL,
    red_cards_home REAL, red_cards_away REAL,
    saves_home REAL, saves_away REAL,
    passes_total_home REAL, passes_total_away REAL,
    passes_accurate_home REAL, passes_accurate_away REAL,
    xg_home REAL, xg_away REAL,
    raw_statistics_json TEXT NOT NULL,
    UNIQUE (session_id, source_client_event_id),
    UNIQUE (fixture_id, provider_event_key)
  )`,
  'CREATE INDEX IF NOT EXISTS live_snapshots_fixture_time_idx ON live_snapshots (fixture_id, captured_at)',
  'CREATE INDEX IF NOT EXISTS live_snapshots_fixture_minute_idx ON live_snapshots (fixture_id, elapsed_minute)',
  `CREATE TABLE IF NOT EXISTS strategy_definitions (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    version TEXT NOT NULL,
    definition_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (name, version)
  )`,
  `CREATE TABLE IF NOT EXISTS strategy_bets (
    id TEXT PRIMARY KEY,
    strategy_id TEXT NOT NULL REFERENCES strategy_definitions(id),
    fixture_id TEXT NOT NULL REFERENCES core_fixtures(id),
    odds_market_value_id INTEGER REFERENCES odds_market_values(id),
    market TEXT NOT NULL,
    selection TEXT NOT NULL,
    line REAL,
    selected_market_odds REAL NOT NULL,
    decided_at TEXT NOT NULL,
    feature_json TEXT NOT NULL,
    UNIQUE (strategy_id, fixture_id, market, selection, line, decided_at)
  )`,
  `CREATE TABLE IF NOT EXISTS bet_settlements (
    strategy_bet_id TEXT PRIMARY KEY REFERENCES strategy_bets(id),
    outcome TEXT NOT NULL CHECK (outcome IN ('WIN', 'LOSS', 'PUSH', 'HALF_WIN', 'HALF_LOSS', 'VOID')),
    profit_units REAL NOT NULL,
    settled_at TEXT NOT NULL,
    detail_json TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS live_signals (
    id TEXT PRIMARY KEY,
    fixture_id TEXT NOT NULL REFERENCES core_fixtures(id),
    team_id TEXT REFERENCES core_teams(id),
    signal_type TEXT NOT NULL,
    signal_version TEXT NOT NULL,
    -- Per-rule dedupe discriminator.  DA v1 uses HOME / AWAY; nullable keeps
    -- any historical rows readable while new projections always set it.
    signal_key TEXT,
    triggered_at TEXT NOT NULL,
    elapsed_minute INTEGER,
    rule_parameters_json TEXT NOT NULL,
    feature_json TEXT NOT NULL,
    UNIQUE (fixture_id, signal_type, signal_version, triggered_at)
  )`,
  `CREATE TABLE IF NOT EXISTS signal_outcomes (
    live_signal_id TEXT PRIMARY KEY REFERENCES live_signals(id),
    goal_within_5m INTEGER,
    goal_within_10m INTEGER,
    goal_within_15m INTEGER,
    next_goal_team_id TEXT REFERENCES core_teams(id),
    home_score_change INTEGER,
    away_score_change INTEGER,
    evaluated_at TEXT NOT NULL,
    detail_json TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS live_signals_fixture_time_idx ON live_signals (fixture_id, triggered_at)',
  'CREATE UNIQUE INDEX IF NOT EXISTS live_signals_rule_side_dedupe_idx ON live_signals (fixture_id, signal_type, signal_version, signal_key) WHERE signal_key IS NOT NULL',
] as const;

// Compatibility export for older route modules.  Keeping it empty prevents a
// page request from silently creating or altering a database.  Run
// `npm run db:local:adopt` before starting the app on an existing local DB.
export const monitorSchema: readonly string[] = [];

// Schema changes are applied by local migration/adoption tooling, never by a
// request handler. D1 rejects an empty `batch`, so this is intentionally a
// no-op once the database has been adopted.
export async function ensureRuntimeSchema(db: D1Database): Promise<void> {
  if (monitorSchema.length > 0) {
    await db.batch(monitorSchema.map((statement) => db.prepare(statement)));
  }
}
