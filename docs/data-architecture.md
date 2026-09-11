# Data architecture

## Boundary

PRE-MATCH and LIVE stay independent pipelines. They may join only through a
`core_fixtures.id`; provider identifiers are never assumed interchangeable.

```text
core_fixtures <- fixture_provider_ids (goal-api / api-football)
  ├─ PRE-MATCH: prematch_form_observations -> odds_capture_runs_v2 -> odds_market_values
  │                                             -> match_results_v2 -> strategy_bets -> bet_settlements
  └─ LIVE: monitor_events (immutable raw) -> live_snapshots -> live_signals -> signal_outcomes
```

## Current migration posture

The existing `form_analysis_runs`, `odds_analysis_runs`, `odds_snapshots`,
`result_snapshots`, and `monitor_events` tables are intentionally retained.
They are raw/legacy audit data. New tables are additive and are created by the
same idempotent schema bootstrap already used by D1 routes. No existing column,
row, API response, or raw JSONL file is removed.

Provider IDs belong in `fixture_provider_ids(provider, external_fixture_id)`,
which is unique. A human-reviewed or deterministic fixture linker may later map
the Goal API UUID and API-Football numeric ID to one `core_fixtures` row. Name
matching alone must not create that cross-provider association.

## Facts vs derived data

- Raw provider responses: existing JSON blobs and JSONL; immutable source of truth.
- Facts: provider fixture mapping, market values, finalized scores, normalised live snapshots.
- Derived: form qualification, signals, strategy choices and settlement outcomes.

`captured_at`, `triggered_at`, and `decided_at` preserve what was known at the
decision moment. Backtests must select the latest odds/form observation at or
before that moment; they must not use a later snapshot.

## Live scale

`monitor_events` remains append-only. `live_snapshots` is a compact projection
for frequent feature queries, keyed by its source raw event. The Collector only
projects a `match_update` after resolving `(goal-api, external_fixture_id)` in
`fixture_provider_ids`; it never creates a core fixture from team names. Use
`(fixture_id, captured_at)` for time windows and `(fixture_id, elapsed_minute)`
for HT→60 / 60→70 reconstruction. Missing provider statistics remain NULL;
zero is never substituted for missing data.

## Rollout

1. Add tables and indexes (this migration).
2. Backfill provider mappings and typed facts from legacy JSON without deleting it.
3. Dual-write new captures, validate row counts and uniqueness.
4. Switch read-side analysis to typed facts.
5. Deprecate legacy reads only after reproducibility checks; do not drop tables
   without an explicit retention decision and backup.

Rollback is safe: application routes continue using legacy tables, so additive
tables can be left unused. No destructive rollback SQL is required.
