#!/usr/bin/env node
/** Local-only raw monitor_events -> live_snapshots recovery tool.
 * Default is READ ONLY. Pass --apply only after a backup and dry-run review.
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { normalizeGoalLiveSnapshot } from '../apps/web-dashboard/lib/goal-live-normalizer.ts';

type Row = {
  fixture_id: string; session_id: string; received_at: string; payload_json: string; client_event_id: string | null;
  provider_timestamp: string | null; payload_hash: string | null; core_fixture_id: string | null;
};

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const dbPath = args.find((value) => !value.startsWith('--'));
const fixtures = args.filter((value, index) => args[index - 1] === '--fixture');
if (!dbPath || !existsSync(dbPath)) throw new Error('usage: live_snapshot_backfill.ts <local.sqlite> [--fixture <goal-id>] [--apply]');

const db = new DatabaseSync(dbPath, { readOnly: !apply });
const required = new Set(['provider', 'provider_fixture_id', 'provider_event_key', 'added_time', 'match_status', 'attacks_home', 'passes_accurate_away']);
const columns = new Set((db.prepare('PRAGMA table_info(live_snapshots)').all() as { name: string }[]).map((row) => row.name));
const missing = [...required].filter((column) => !columns.has(column));
if (missing.length) throw new Error(`local D1 is not adopted for live projection: ${missing.join(', ')}`);

const where = fixtures.length ? ` AND m.fixture_id IN (${fixtures.map(() => '?').join(',')})` : '';
const rows = db.prepare(`SELECT m.fixture_id,m.session_id,m.received_at,m.payload_json,m.client_event_id,m.provider_timestamp,m.payload_hash,
  f.fixture_id AS core_fixture_id
  FROM monitor_events m
  LEFT JOIN fixture_provider_ids f ON f.provider='goal-api' AND f.external_fixture_id=m.fixture_id
  WHERE m.event_type='match_update'${where}
  ORDER BY m.received_at,m.id`).all(...fixtures) as Row[];

const summary = { sourceEvents: rows.length, eligible: 0, normalized: 0, existing: 0, wouldUpdate: 0, inserted: 0, updated: 0, duplicates: 0, skipped: 0, malformed: 0, identityUnresolved: 0 };
const snapshots = [] as ReturnType<typeof normalizeGoalLiveSnapshot>[];
const existingSnapshot = db.prepare('SELECT provider_fixture_id FROM live_snapshots WHERE session_id=? AND source_client_event_id=?');
for (const row of rows) {
  if (!row.core_fixture_id) { summary.identityUnresolved += 1; continue; }
  summary.eligible += 1;
  let payload: unknown;
  try { payload = JSON.parse(row.payload_json); } catch { summary.malformed += 1; continue; }
  const snapshot = normalizeGoalLiveSnapshot({ fixtureId: row.fixture_id, receivedAt: row.received_at, payload, clientEventId: row.client_event_id ?? undefined, providerTimestamp: row.provider_timestamp, payloadHash: row.payload_hash }, row.core_fixture_id);
  if (!snapshot) { summary.skipped += 1; continue; }
  summary.normalized += 1; snapshots.push(snapshot);
  if (!apply) {
    const existing = existingSnapshot.get(row.session_id, snapshot.sourceClientEventId) as { provider_fixture_id: string | null } | undefined;
    if (existing) { summary.existing += 1; if (!existing.provider_fixture_id) summary.wouldUpdate += 1; }
  }
}

if (apply && snapshots.length) {
  const insert = db.prepare(`INSERT OR IGNORE INTO live_snapshots
    (fixture_id,session_id,source_client_event_id,provider,provider_fixture_id,provider_event_key,provider_timestamp,captured_at,
     elapsed_minute,added_time,match_status,home_score,away_score,shots_home,shots_away,shots_on_target_home,shots_on_target_away,
     corners_home,corners_away,attacks_home,attacks_away,dangerous_attacks_home,dangerous_attacks_away,possession_home,possession_away,
     yellow_cards_home,yellow_cards_away,red_cards_home,red_cards_away,saves_home,saves_away,passes_total_home,passes_total_away,
     passes_accurate_home,passes_accurate_away,xg_home,xg_away,raw_statistics_json)
    VALUES (${Array.from({ length: 38 }, () => '?').join(',')})`);
  const updateLegacy = db.prepare(`UPDATE live_snapshots SET
    provider=?,provider_fixture_id=?,provider_event_key=?,provider_timestamp=?,captured_at=?,elapsed_minute=?,added_time=?,match_status=?,
    home_score=?,away_score=?,shots_home=?,shots_away=?,shots_on_target_home=?,shots_on_target_away=?,corners_home=?,corners_away=?,
    attacks_home=?,attacks_away=?,dangerous_attacks_home=?,dangerous_attacks_away=?,possession_home=?,possession_away=?,
    yellow_cards_home=?,yellow_cards_away=?,red_cards_home=?,red_cards_away=?,saves_home=?,saves_away=?,passes_total_home=?,passes_total_away=?,
    passes_accurate_home=?,passes_accurate_away=?,xg_home=?,xg_away=?,raw_statistics_json=?
    WHERE session_id=? AND source_client_event_id=? AND provider_fixture_id IS NULL`);
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const snapshot of snapshots) {
      const source = rows.find((row) => row.client_event_id === snapshot.sourceClientEventId);
      if (!source) throw new Error(`source event disappeared: ${snapshot.sourceClientEventId}`);
      const values = [snapshot.coreFixtureId, source.session_id, snapshot.sourceClientEventId,
        snapshot.provider, snapshot.providerFixtureId, snapshot.providerEventKey, snapshot.providerTimestamp, snapshot.capturedAt,
        snapshot.elapsedMinute, snapshot.addedTime, snapshot.matchStatus, snapshot.homeScore, snapshot.awayScore,
        snapshot.shotsHome, snapshot.shotsAway, snapshot.shotsOnTargetHome, snapshot.shotsOnTargetAway,
        snapshot.cornersHome, snapshot.cornersAway, snapshot.attacksHome, snapshot.attacksAway,
        snapshot.dangerousAttacksHome, snapshot.dangerousAttacksAway, snapshot.possessionHome, snapshot.possessionAway,
        snapshot.yellowCardsHome, snapshot.yellowCardsAway, snapshot.redCardsHome, snapshot.redCardsAway,
        snapshot.savesHome, snapshot.savesAway, snapshot.passesTotalHome, snapshot.passesTotalAway,
        snapshot.passesAccurateHome, snapshot.passesAccurateAway, snapshot.xgHome, snapshot.xgAway, JSON.stringify(snapshot.rawStatistics)];
      const result = insert.run(...values);
      if (result.changes) { summary.inserted += 1; continue; }
      const legacyValues = [snapshot.provider, snapshot.providerFixtureId, snapshot.providerEventKey, snapshot.providerTimestamp, snapshot.capturedAt,
        snapshot.elapsedMinute, snapshot.addedTime, snapshot.matchStatus, snapshot.homeScore, snapshot.awayScore,
        snapshot.shotsHome, snapshot.shotsAway, snapshot.shotsOnTargetHome, snapshot.shotsOnTargetAway, snapshot.cornersHome, snapshot.cornersAway,
        snapshot.attacksHome, snapshot.attacksAway, snapshot.dangerousAttacksHome, snapshot.dangerousAttacksAway,
        snapshot.possessionHome, snapshot.possessionAway, snapshot.yellowCardsHome, snapshot.yellowCardsAway,
        snapshot.redCardsHome, snapshot.redCardsAway, snapshot.savesHome, snapshot.savesAway,
        snapshot.passesTotalHome, snapshot.passesTotalAway, snapshot.passesAccurateHome, snapshot.passesAccurateAway,
        snapshot.xgHome, snapshot.xgAway, JSON.stringify(snapshot.rawStatistics), source.session_id, snapshot.sourceClientEventId];
      if (updateLegacy.run(...legacyValues).changes) summary.updated += 1; else summary.duplicates += 1;
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', fixtures: fixtures.length || 'all', ...summary }, null, 2));
db.close();
