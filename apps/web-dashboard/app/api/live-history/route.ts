import { env } from 'cloudflare:workers';
import { ensureMonitorSchema } from '@/db/monitor';
import { buildLiveHistoryDetail, historyStatus, snapshotFromRawGoalMonitorEvent, type LiveHistorySignal } from '@/lib/live-history';
import type { LiveSnapshot } from '@/lib/live-delta';

export const dynamic = 'force-dynamic';

function database() { return (env as unknown as { DB: D1Database }).DB; }
function parseJson(value: string) { try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null; } catch { return null; } }
function boundedInteger(value: string | null, fallback: number, maximum: number) { const number = Number(value); return Number.isInteger(number) && number > 0 ? Math.min(number, maximum) : fallback; }

type SummaryRow = {
  fixtureId: string; providerFixtureId: string | null; home: string; away: string; kickoffUtc: string | null;
  snapshotCount: number; firstCapturedAt: string; latestCapturedAt: string; firstSnapshotMinute: number | null; lastSnapshotMinute: number | null;
  actualHtObserved: number; latestStatus: string | null; latestHomeScore: number | null; latestAwayScore: number | null; signalCount: number;
};

const RAW_FIXTURE_PREFIX = 'raw:goal-api:';
const rawHistoryFixtureId = (providerFixtureId: string) => `${RAW_FIXTURE_PREFIX}${providerFixtureId}`;
const rawProviderFixtureId = (fixtureId: string) => fixtureId.startsWith(RAW_FIXTURE_PREFIX) ? fixtureId.slice(RAW_FIXTURE_PREFIX.length) : null;

type RawEventRow = {
  id: number; fixtureId: string; receivedAt: string; status: string | null; home: string | null; away: string | null;
  homeScore: string | null; awayScore: string | null; payloadJson: string; clientEventId: string | null;
  providerTimestamp: string | null; payloadHash: string | null;
};

async function listHistory(db: D1Database, limit: number, offset: number) {
  const result = await db.prepare(`WITH fixture_summary AS (
    SELECT fixture_id, COUNT(*) AS snapshotCount, MIN(captured_at) AS firstCapturedAt, MAX(captured_at) AS latestCapturedAt,
      MIN(elapsed_minute) AS firstSnapshotMinute, MAX(elapsed_minute) AS lastSnapshotMinute,
      MAX(CASE WHEN upper(replace(replace(match_status,'_',' '),'-',' ')) IN ('HT','HALF TIME') THEN 1 ELSE 0 END) AS actualHtObserved
    FROM live_snapshots GROUP BY fixture_id
  )
  SELECT s.fixture_id AS fixtureId, p.external_fixture_id AS providerFixtureId, f.home_name AS home, f.away_name AS away, f.kickoff_utc AS kickoffUtc,
    s.snapshotCount, s.firstCapturedAt, s.latestCapturedAt, s.firstSnapshotMinute, s.lastSnapshotMinute, s.actualHtObserved,
    (SELECT ls.match_status FROM live_snapshots ls WHERE ls.fixture_id=s.fixture_id ORDER BY ls.captured_at DESC, ls.id DESC LIMIT 1) AS latestStatus,
    (SELECT ls.home_score FROM live_snapshots ls WHERE ls.fixture_id=s.fixture_id ORDER BY ls.captured_at DESC, ls.id DESC LIMIT 1) AS latestHomeScore,
    (SELECT ls.away_score FROM live_snapshots ls WHERE ls.fixture_id=s.fixture_id ORDER BY ls.captured_at DESC, ls.id DESC LIMIT 1) AS latestAwayScore,
    (SELECT COUNT(*) FROM live_signals signal WHERE signal.fixture_id=s.fixture_id) AS signalCount
  FROM fixture_summary s
  JOIN core_fixtures f ON f.id=s.fixture_id
  LEFT JOIN fixture_provider_ids p ON p.fixture_id=s.fixture_id AND p.provider='goal-api'
  ORDER BY s.latestCapturedAt DESC LIMIT ? OFFSET ?`).bind(limit, offset).all<SummaryRow>();
  const count = await db.prepare('SELECT COUNT(DISTINCT fixture_id) AS total FROM live_snapshots').first<{ total: number }>();
  const typed = (result.results ?? []).map((row) => ({ ...row, status: historyStatus(row.latestStatus), actualHtObserved: Boolean(row.actualHtObserved), identity: 'resolved' as const }));
  // A manual/legacy fixture can have sound raw monitor events but no safe
  // provider identity.  Keep it visible as RAW-only instead of pretending the
  // data never arrived.  This read-only fallback never creates a core fixture.
  const raw = await db.prepare(`SELECT e.fixture_id AS providerFixtureId, COUNT(*) AS snapshotCount,
      MIN(e.received_at) AS firstCapturedAt, MAX(e.received_at) AS latestCapturedAt,
      MAX(e.home) AS home, MAX(e.away) AS away,
      (SELECT latest.status FROM monitor_events latest WHERE latest.fixture_id=e.fixture_id AND latest.event_type='match_update' ORDER BY latest.received_at DESC, latest.id DESC LIMIT 1) AS latestStatus,
      (SELECT latest.home_score FROM monitor_events latest WHERE latest.fixture_id=e.fixture_id AND latest.event_type='match_update' ORDER BY latest.received_at DESC, latest.id DESC LIMIT 1) AS latestHomeScore,
      (SELECT latest.away_score FROM monitor_events latest WHERE latest.fixture_id=e.fixture_id AND latest.event_type='match_update' ORDER BY latest.received_at DESC, latest.id DESC LIMIT 1) AS latestAwayScore
    FROM monitor_events e WHERE e.event_type='match_update' AND NOT EXISTS (
      SELECT 1 FROM fixture_provider_ids map WHERE map.provider='goal-api' AND map.external_fixture_id=e.fixture_id
    ) GROUP BY e.fixture_id ORDER BY latestCapturedAt DESC LIMIT ? OFFSET ?`).bind(limit, offset).all<{
      providerFixtureId: string; snapshotCount: number; firstCapturedAt: string; latestCapturedAt: string; home: string | null; away: string | null;
      latestStatus: string | null; latestHomeScore: string | null; latestAwayScore: string | null;
    }>();
  const rawOnly = (raw.results ?? []).map((row) => ({ fixtureId: rawHistoryFixtureId(row.providerFixtureId), providerFixtureId: row.providerFixtureId,
    home: row.home ?? 'Home', away: row.away ?? 'Away', kickoffUtc: null, snapshotCount: Number(row.snapshotCount),
    firstCapturedAt: row.firstCapturedAt, latestCapturedAt: row.latestCapturedAt, firstSnapshotMinute: null, lastSnapshotMinute: null,
    actualHtObserved: false, latestStatus: row.latestStatus, latestHomeScore: row.latestHomeScore === null ? null : Number(row.latestHomeScore),
    latestAwayScore: row.latestAwayScore === null ? null : Number(row.latestAwayScore), signalCount: 0,
    status: historyStatus(row.latestStatus), identity: 'raw_only' as const }));
  const fixtures = [...typed, ...rawOnly].sort((a, b) => b.latestCapturedAt.localeCompare(a.latestCapturedAt)).slice(0, limit);
  return { total: Number(count?.total ?? 0) + rawOnly.length, fixtures };
}

async function detailHistory(db: D1Database, fixtureId: string) {
  const providerFixtureId = rawProviderFixtureId(fixtureId);
  if (providerFixtureId) {
    const events = await db.prepare(`SELECT id,fixture_id AS fixtureId,received_at AS receivedAt,status,home,away,
      home_score AS homeScore,away_score AS awayScore,payload_json AS payloadJson,client_event_id AS clientEventId,
      provider_timestamp AS providerTimestamp,payload_hash AS payloadHash
      FROM monitor_events WHERE fixture_id=? AND event_type='match_update' ORDER BY received_at,id LIMIT 1000`).bind(providerFixtureId).all<RawEventRow>();
    if (!events.results?.length) return null;
    const first = events.results[0];
    const bookmark = await db.prepare('SELECT kickoff_utc AS kickoffUtc FROM fixture_bookmarks WHERE fixture_id=?').bind(providerFixtureId).first<{ kickoffUtc: string | null }>();
    const snapshots = events.results.map((event) => {
      const payload = parseJson(event.payloadJson);
      return payload ? snapshotFromRawGoalMonitorEvent({ ...event, payload }, fixtureId) : null;
    }).filter((snapshot): snapshot is LiveSnapshot => snapshot !== null);
    const detail = buildLiveHistoryDetail({ fixtureId, providerFixtureId, home: first.home ?? 'Home', away: first.away ?? 'Away', kickoffUtc: bookmark?.kickoffUtc ?? null }, snapshots, []);
    return { ...detail, identity: 'raw_only' as const, rawEventCount: events.results.length };
  }
  const fixture = await db.prepare(`SELECT f.id AS fixtureId, p.external_fixture_id AS providerFixtureId, f.home_name AS home, f.away_name AS away, f.kickoff_utc AS kickoffUtc
    FROM core_fixtures f LEFT JOIN fixture_provider_ids p ON p.fixture_id=f.id AND p.provider='goal-api' WHERE f.id=?`).bind(fixtureId).first<{
      fixtureId: string; providerFixtureId: string | null; home: string; away: string; kickoffUtc: string | null;
    }>();
  if (!fixture) return null;
  const snapshots = await db.prepare(`SELECT id,fixture_id,source_client_event_id,provider_event_key,captured_at,elapsed_minute,added_time,match_status,
    home_score,away_score,shots_home,shots_away,shots_on_target_home,shots_on_target_away,corners_home,corners_away,attacks_home,attacks_away,
    dangerous_attacks_home,dangerous_attacks_away,possession_home,possession_away,yellow_cards_home,yellow_cards_away,red_cards_home,red_cards_away,
    saves_home,saves_away,passes_total_home,passes_total_away,passes_accurate_home,passes_accurate_away
    FROM live_snapshots WHERE fixture_id=? ORDER BY captured_at,id LIMIT 1000`).bind(fixtureId).all<LiveSnapshot>();
  const signals = await db.prepare(`SELECT id,signal_type AS ruleId,signal_version AS ruleVersion,signal_key AS signalSide,triggered_at AS triggeredAt,
    elapsed_minute AS detectedMinute,rule_parameters_json AS ruleParametersJson,feature_json AS featureJson
    FROM live_signals WHERE fixture_id=? ORDER BY triggered_at,id`).bind(fixtureId).all<LiveHistorySignal & { ruleParametersJson: string; featureJson: string }>();
  const mappedSignals: LiveHistorySignal[] = (signals.results ?? []).map((signal) => ({
    id: signal.id, ruleId: signal.ruleId, ruleVersion: signal.ruleVersion, signalSide: signal.signalSide,
    triggeredAt: signal.triggeredAt, detectedMinute: signal.detectedMinute,
    ruleParameters: parseJson(signal.ruleParametersJson), feature: parseJson(signal.featureJson),
  }));
  return { ...buildLiveHistoryDetail(fixture, snapshots.results ?? [], mappedSignals), identity: 'resolved' as const };
}

export async function GET(request: Request) {
  const db = database(); await ensureMonitorSchema(db);
  const url = new URL(request.url); const fixtureId = url.searchParams.get('fixtureId')?.trim();
  if (fixtureId) {
    const detail = await detailHistory(db, fixtureId);
    return detail ? Response.json({ detail }, { headers: { 'Cache-Control': 'no-store' } }) : Response.json({ error: 'LIVE履歴が見つかりません' }, { status: 404 });
  }
  const limit = boundedInteger(url.searchParams.get('limit'), 50, 100);
  const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
  return Response.json(await listHistory(db, limit, offset), { headers: { 'Cache-Control': 'no-store' } });
}
