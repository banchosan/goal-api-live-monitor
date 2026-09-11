import { env } from 'cloudflare:workers';
import { ensureMonitorSchema } from '@/db/monitor';
import { normalizeGoalLiveSnapshot } from '@/lib/goal-live-normalizer';

export const dynamic = 'force-dynamic';

type StoredEvent = {
  sessionId: string;
  fixtureId: string;
  eventType: string;
  receivedAt: string;
  status?: string;
  home?: string;
  away?: string;
  homeScore?: string;
  awayScore?: string;
  payload: unknown;
  clientEventId?: string;
  connectionId?: string;
  sequence?: number;
  source?: string;
  providerTimestamp?: string;
  payloadHash?: string;
  schemaVersion?: number;
};

function database() {
  return (env as unknown as { DB: D1Database }).DB;
}

export async function POST(request: Request) {
  const body = await request.json() as { events?: StoredEvent[] };
  const events = Array.isArray(body.events) ? body.events.slice(0, 100) : [];
  if (!events.length) return Response.json({ error: 'eventsが空です' }, { status: 400 });
  if (events.some((event) => !event.sessionId || !event.fixtureId || !event.eventType || !event.receivedAt)) {
    return Response.json({ error: '必須フィールドが不足しています' }, { status: 400 });
  }

  const db = database();
  await ensureMonitorSchema(db);
  const insert = db.prepare(`INSERT OR IGNORE INTO monitor_events
    (session_id, fixture_id, event_type, received_at, status, home, away, home_score, away_score, payload_json,
     client_event_id, connection_id, sequence, source, provider_timestamp, payload_hash, schema_version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  await db.batch(events.map((event) => insert.bind(
    event.sessionId,
    event.fixtureId,
    event.eventType,
    event.receivedAt,
    event.status ?? null,
    event.home ?? null,
    event.away ?? null,
    event.homeScore ?? null,
    event.awayScore ?? null,
    JSON.stringify(event.payload),
    event.clientEventId ?? null,
    event.connectionId ?? null,
    Number.isFinite(event.sequence) ? event.sequence : null,
    event.source ?? 'browser',
    event.providerTimestamp ?? null,
    event.payloadHash ?? null,
    event.schemaVersion ?? 1,
  )));
  // Raw monitor_events is the durable primary record. Projection is best-effort
  // so a typed failure never makes the collector retry this raw batch.
  const projection = await persistLiveSnapshots(db, events).catch((error) => ({
    saved: 0, skipped: 0, duplicates: 0, errors: 1,
    error: error instanceof Error ? error.message : String(error),
  }));
  return Response.json({ saved: events.length, projection });
}

type ProjectionSummary = { saved: number; skipped: number; duplicates: number; errors: number; error?: string };

async function persistLiveSnapshots(db: D1Database, events: StoredEvent[]): Promise<ProjectionSummary> {
  const statements: D1PreparedStatement[] = [];
  const summary: ProjectionSummary = { saved: 0, skipped: 0, duplicates: 0, errors: 0 };
  for (const event of events) {
    if (event.eventType !== 'match_update' || !event.clientEventId) { summary.skipped += 1; continue; }
    const mapping = await db.prepare(`SELECT fixture_id FROM fixture_provider_ids
      WHERE provider='goal-api' AND external_fixture_id=?`).bind(event.fixtureId).first<{ fixture_id: string }>();
    // No name-based fallback: an unresolved fixture remains raw-only.
    if (!mapping?.fixture_id) { summary.skipped += 1; continue; }
    const snapshot = normalizeGoalLiveSnapshot(event, mapping.fixture_id);
    if (!snapshot) { summary.skipped += 1; continue; }
    statements.push(db.prepare(`INSERT OR IGNORE INTO live_snapshots
      (fixture_id,session_id,source_client_event_id,provider,provider_fixture_id,provider_event_key,provider_timestamp,captured_at,
       elapsed_minute,added_time,match_status,home_score,away_score,shots_home,shots_away,shots_on_target_home,shots_on_target_away,
       corners_home,corners_away,attacks_home,attacks_away,dangerous_attacks_home,dangerous_attacks_away,possession_home,possession_away,
       yellow_cards_home,yellow_cards_away,red_cards_home,red_cards_away,saves_home,saves_away,passes_total_home,passes_total_away,
       passes_accurate_home,passes_accurate_away,xg_home,xg_away,raw_statistics_json)
      VALUES (${Array.from({ length: 38 }, () => '?').join(',')})`).bind(
      snapshot.coreFixtureId, event.sessionId, snapshot.sourceClientEventId, snapshot.provider, snapshot.providerFixtureId,
      snapshot.providerEventKey, snapshot.providerTimestamp, snapshot.capturedAt, snapshot.elapsedMinute, snapshot.addedTime,
      snapshot.matchStatus, snapshot.homeScore, snapshot.awayScore, snapshot.shotsHome, snapshot.shotsAway,
      snapshot.shotsOnTargetHome, snapshot.shotsOnTargetAway, snapshot.cornersHome, snapshot.cornersAway,
      snapshot.attacksHome, snapshot.attacksAway, snapshot.dangerousAttacksHome, snapshot.dangerousAttacksAway,
      snapshot.possessionHome, snapshot.possessionAway, snapshot.yellowCardsHome, snapshot.yellowCardsAway,
      snapshot.redCardsHome, snapshot.redCardsAway, snapshot.savesHome, snapshot.savesAway,
      snapshot.passesTotalHome, snapshot.passesTotalAway, snapshot.passesAccurateHome, snapshot.passesAccurateAway,
      snapshot.xgHome, snapshot.xgAway, JSON.stringify(snapshot.rawStatistics),
    ));
  }
  if (!statements.length) return summary;
  try {
    const results = await db.batch(statements);
    summary.saved = results.filter((result) => Number(result.meta?.changes ?? 0) > 0).length;
    summary.duplicates = statements.length - summary.saved;
  }
  catch (error) { return { ...summary, saved: 0, errors: statements.length, error: error instanceof Error ? error.message : String(error) }; }
  return summary;
}

export async function GET() {
  const db = database();
  await ensureMonitorSchema(db);
  const summary = await db.prepare(`SELECT fixture_id AS fixtureId, MAX(home) AS home, MAX(away) AS away,
    COUNT(*) AS events, SUM(CASE WHEN event_type = 'manual_snapshot' THEN 1 ELSE 0 END) AS snapshots,
    MIN(received_at) AS firstSeenAt, MAX(received_at) AS lastSeenAt
    FROM monitor_events GROUP BY fixture_id ORDER BY lastSeenAt DESC LIMIT 200`).all();
  return Response.json({ fixtures: summary.results });
}
