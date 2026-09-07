import { env } from 'cloudflare:workers';
import { ensureMonitorSchema } from '@/db/monitor';
import { normalizeMonitorExclusionInput } from '@/lib/monitor-exclusions';

export const dynamic = 'force-dynamic';
const db = () => (env as unknown as { DB: D1Database }).DB;

export async function GET(request: Request) {
  const database = db(); await ensureMonitorSchema(database);
  const includeInactive = new URL(request.url).searchParams.get('includeInactive') === 'true';
  const result = await database.prepare(`SELECT fixture_id AS fixtureId, home, away, reason, active,
    excluded_at AS excludedAt, restored_at AS restoredAt, updated_at AS updatedAt
    FROM monitor_fixture_exclusions ${includeInactive ? '' : 'WHERE active=1'} ORDER BY updated_at DESC`).all();
  return Response.json({ exclusions: result.results });
}

export async function POST(request: Request) {
  let input;
  try { input = normalizeMonitorExclusionInput(await request.json()); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : '入力エラー' }, { status: 400 }); }
  const database = db(); await ensureMonitorSchema(database); const now = new Date().toISOString();
  await database.prepare(`INSERT INTO monitor_fixture_exclusions
    (fixture_id,home,away,reason,active,excluded_at,restored_at,updated_at) VALUES (?,?,?,?,1,?,NULL,?)
    ON CONFLICT(fixture_id) DO UPDATE SET home=excluded.home, away=excluded.away, reason=excluded.reason,
    active=1, excluded_at=excluded.excluded_at, restored_at=NULL, updated_at=excluded.updated_at`)
    .bind(input.fixtureId,input.home,input.away,input.reason,now,now).run();
  return Response.json({ excluded: true, fixtureId: input.fixtureId, bookmarkPreserved: true, historicalDataPreserved: true }, { status: 201 });
}

export async function DELETE(request: Request) {
  const fixtureId = new URL(request.url).searchParams.get('fixtureId');
  if (!fixtureId) return Response.json({ error: 'fixtureIdが必要です' }, { status: 400 });
  const database = db(); await ensureMonitorSchema(database); const now = new Date().toISOString();
  const result = await database.prepare('UPDATE monitor_fixture_exclusions SET active=0, restored_at=?, updated_at=? WHERE fixture_id=? AND active=1')
    .bind(now,now,fixtureId).run();
  return result.meta.changes ? Response.json({ restored: true, fixtureId }) : Response.json({ error: '監視除外が見つかりません' }, { status: 404 });
}
