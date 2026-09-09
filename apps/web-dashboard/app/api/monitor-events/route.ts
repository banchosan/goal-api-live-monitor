import { env } from 'cloudflare:workers';
import { ensureMonitorSchema } from '@/db/monitor';
import { projectLiveSnapshot } from '@/lib/live-snapshot';

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
  await persistLiveFacts(db, events);
  return Response.json({ saved: events.length });
}

function coreTeamId(name: string) {
  // Preserve non-Latin names; ASCII-only slugging would collapse distinct teams.
  return `goal-api:team:${encodeURIComponent(name.normalize('NFKC').trim().toLowerCase())}`;
}

async function persistLiveFacts(db: D1Database, events: StoredEvent[]) {
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [];
  for (const event of events) {
    if (event.eventType !== 'match_update' || !event.clientEventId) continue;
    const home = event.home ?? 'Home'; const away = event.away ?? 'Away';
    const homeTeamId = coreTeamId(home); const awayTeamId = coreTeamId(away);
    const fixtureId = `goal-api:${event.fixtureId}`;
    statements.push(
      db.prepare(`INSERT INTO core_teams (id,name,created_at,updated_at) VALUES (?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name,updated_at=excluded.updated_at`).bind(homeTeamId, home, now, now),
      db.prepare(`INSERT INTO core_teams (id,name,created_at,updated_at) VALUES (?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name,updated_at=excluded.updated_at`).bind(awayTeamId, away, now, now),
      db.prepare(`INSERT INTO core_fixtures (id,home_team_id,away_team_id,home_name,away_name,created_at,updated_at) VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET home_name=excluded.home_name,away_name=excluded.away_name,updated_at=excluded.updated_at`).bind(fixtureId, homeTeamId, awayTeamId, home, away, now, now),
      db.prepare(`INSERT INTO fixture_provider_ids (provider,external_fixture_id,fixture_id,first_seen_at,last_seen_at) VALUES ('goal-api',?,?,?,?)
        ON CONFLICT(provider,external_fixture_id) DO UPDATE SET last_seen_at=excluded.last_seen_at`).bind(event.fixtureId, fixtureId, now, now),
    );
    const snapshot = projectLiveSnapshot(event.payload);
    statements.push(db.prepare(`INSERT OR IGNORE INTO live_snapshots
      (fixture_id,session_id,source_client_event_id,provider_timestamp,captured_at,elapsed_minute,home_score,away_score,
       shots_home,shots_away,shots_on_target_home,shots_on_target_away,corners_home,corners_away,
       dangerous_attacks_home,dangerous_attacks_away,possession_home,possession_away,xg_home,xg_away,raw_statistics_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      fixtureId, event.sessionId, event.clientEventId, event.providerTimestamp ?? null, event.receivedAt,
      snapshot.elapsedMinute, snapshot.homeScore, snapshot.awayScore, snapshot.shotsHome, snapshot.shotsAway,
      snapshot.shotsOnTargetHome, snapshot.shotsOnTargetAway, snapshot.cornersHome, snapshot.cornersAway,
      snapshot.dangerousAttacksHome, snapshot.dangerousAttacksAway, snapshot.possessionHome, snapshot.possessionAway,
      snapshot.xgHome, snapshot.xgAway, JSON.stringify(snapshot.rawStatistics),
    ));
  }
  if (statements.length) await db.batch(statements);
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
