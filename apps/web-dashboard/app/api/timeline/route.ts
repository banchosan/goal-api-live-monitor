import { env } from 'cloudflare:workers';
import { ensureMonitorSchema } from '@/db/monitor';
import { reconstructAtMinute, type TimelineEvent } from '@/lib/timeline';

export const dynamic = 'force-dynamic';

type TimelineRow = Omit<TimelineEvent, 'payload'> & { payloadJson: string };

export async function GET(request: Request) {
  const url = new URL(request.url);
  const fixtureId = url.searchParams.get('fixtureId') ?? '';
  const sessionId = url.searchParams.get('sessionId') ?? undefined;
  const targetMinute = Number(url.searchParams.get('minute'));
  if (!fixtureId || !Number.isInteger(targetMinute) || targetMinute < 0 || targetMinute > 130) {
    return Response.json({ error: 'fixtureIdと0〜130のminuteが必要です' }, { status: 400 });
  }
  const db = (env as unknown as { DB: D1Database }).DB;
  await ensureMonitorSchema(db);
  const query = sessionId
    ? db.prepare(`SELECT id, session_id AS sessionId, fixture_id AS fixtureId, event_type AS eventType,
        received_at AS receivedAt, connection_id AS connectionId, sequence, source, payload_json AS payloadJson
        FROM monitor_events WHERE fixture_id=? AND session_id=? ORDER BY received_at, id`).bind(fixtureId, sessionId)
    : db.prepare(`SELECT id, session_id AS sessionId, fixture_id AS fixtureId, event_type AS eventType,
        received_at AS receivedAt, connection_id AS connectionId, sequence, source, payload_json AS payloadJson
        FROM monitor_events WHERE fixture_id=? ORDER BY received_at, id`).bind(fixtureId);
  const rows = await query.all<TimelineRow>();
  const events: TimelineEvent[] = (rows.results ?? []).map((row) => ({ ...row, payload: JSON.parse(row.payloadJson) }));
  return Response.json(reconstructAtMinute(events, fixtureId, targetMinute, sessionId), { headers: { 'Cache-Control': 'no-store' } });
}
