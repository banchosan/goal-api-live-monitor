import { env } from 'cloudflare:workers';
import { ensureMonitorSchema } from '@/db/monitor';
import { buildLiveHistoryDetail, historyStatus, type LiveHistorySignal } from '@/lib/live-history';
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
  return { total: Number(count?.total ?? 0), fixtures: (result.results ?? []).map((row) => ({ ...row, status: historyStatus(row.latestStatus), actualHtObserved: Boolean(row.actualHtObserved) })) };
}

async function detailHistory(db: D1Database, fixtureId: string) {
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
  return buildLiveHistoryDetail(fixture, snapshots.results ?? [], mappedSignals);
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
