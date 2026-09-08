import { env } from 'cloudflare:workers';
import { monitorSchema } from '@/db/schema';
import { chunkFixtureIds, fixtureDetails, resultFixtureRecords } from '@/lib/result-capture';

export const dynamic = 'force-dynamic';
const BASE = 'https://v3.football.api-sports.io';

type SnapshotRow = { api_fixture_id: string | number };

async function parseJsonResponse(response: Response) {
  const text = await response.text();
  try {
    return JSON.parse(text) as { response?: unknown };
  } catch {
    return null;
  }
}

export async function POST(request: Request) {
  const key = process.env.API_FOOTBALL_KEY;
  if (!key) return Response.json({ error: 'API_FOOTBALL_KEYが未設定です', apiRequests: 0 }, { status: 500 });

  const body = await request.json().catch(() => ({})) as { runId?: string };
  if (!body.runId) return Response.json({ error: 'runIdが必要です', apiRequests: 0 }, { status: 400 });

  const db = (env as unknown as { DB: D1Database }).DB;
  await db.batch(monitorSchema.map((sql) => db.prepare(sql)));
  const snapshots = await db.prepare('SELECT api_fixture_id FROM odds_snapshots WHERE run_id=?').bind(body.runId).all<SnapshotRow>();
  const batches = chunkFixtureIds((snapshots.results ?? []).map((snapshot) => snapshot.api_fixture_id));
  const responses: Array<{ fixtureIds: string[]; response: Record<string, unknown>[] }> = [];
  let apiRequests = 0;

  for (const fixtureIds of batches) {
    // API-Football documents this endpoint as returning fixture result, events and statistics for up to 20 IDs.
    const response = await fetch(`${BASE}/fixtures?${new URLSearchParams({ ids: fixtureIds.join('-') })}`, {
      headers: { 'x-apisports-key': key },
      cache: 'no-store',
    });
    apiRequests += 1;
    const payload = await parseJsonResponse(response);
    if (!response.ok) return Response.json({ error: `API-Football HTTP ${response.status}`, apiRequests }, { status: response.status });
    if (!payload) return Response.json({ error: 'API-FootballからJSON以外の応答を受信しました', apiRequests }, { status: 502 });
    responses.push({ fixtureIds, response: fixtureDetails(payload.response) });
  }

  const createdAt = new Date().toISOString();
  const rawSnapshot = { format: 'api-football-fixtures-ids-v1', batches: responses };
  const fixtures = resultFixtureRecords(rawSnapshot);
  const statisticsAvailable = fixtures.filter((fixture) => Array.isArray(fixture.statistics)).length;
  await db.prepare('INSERT INTO result_snapshots (odds_run_id,created_at,api_requests,raw_json) VALUES (?,?,?,?)')
    .bind(body.runId, createdAt, apiRequests, JSON.stringify(rawSnapshot)).run();

  return Response.json({ saved: true, runId: body.runId, createdAt, apiRequests, fixtures: fixtures.length, statisticsAvailable });
}

export async function GET(request: Request) {
  const runId = new URL(request.url).searchParams.get('runId');
  const db = (env as unknown as { DB: D1Database }).DB;
  await db.batch(monitorSchema.map((sql) => db.prepare(sql)));
  const row = runId
    ? await db.prepare('SELECT created_at,api_requests,raw_json FROM result_snapshots WHERE odds_run_id=? ORDER BY created_at DESC LIMIT 1').bind(runId).first<{ created_at: string; api_requests: number; raw_json: string }>()
    : null;
  const raw = row ? JSON.parse(row.raw_json) : null;
  return Response.json({ result: row ? { createdAt: row.created_at, apiRequests: row.api_requests, fixtures: resultFixtureRecords(raw).length } : null });
}
