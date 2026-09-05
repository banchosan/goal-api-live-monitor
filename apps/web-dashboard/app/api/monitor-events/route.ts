import { env } from 'cloudflare:workers';
import { ensureMonitorSchema } from '@/db/monitor';

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
  return Response.json({ saved: events.length });
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
