import { env } from 'cloudflare:workers';
import { ensureRuntimeSchema } from '@/db/schema';
import { fixtureDetails, resultFixtureRecords } from '@/lib/result-capture';
import { saveTypedResults } from '@/lib/prematch-dual-write';

export const dynamic = 'force-dynamic';
const BASE = 'https://v3.football.api-sports.io';

type SnapshotRow = { api_fixture_id: string | number; kickoff: string };

function jstDate(value: string) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(value));
}

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
  await ensureRuntimeSchema(db);
  const snapshots = await db.prepare('SELECT api_fixture_id,kickoff FROM odds_snapshots WHERE run_id=?').bind(body.runId).all<SnapshotRow>();
  const fixtureIds = new Set((snapshots.results ?? []).map((snapshot) => String(snapshot.api_fixture_id)));
  const dates = [...new Set((snapshots.results ?? []).map((snapshot) => jstDate(snapshot.kickoff)))];
  const responses: Array<{ date: string; response: Record<string, unknown>[] }> = [];
  let apiRequests = 0;

  for (const date of dates) {
    // The current API-Football Free plan rejects the otherwise-documented `ids` parameter.
    // Fetch a single JST day and retain only the fixture IDs saved with this odds run.
    const response = await fetch(`${BASE}/fixtures?${new URLSearchParams({ date, timezone: 'Asia/Tokyo' })}`, {
      headers: { 'x-apisports-key': key },
      cache: 'no-store',
    });
    apiRequests += 1;
    const payload = await parseJsonResponse(response);
    if (!response.ok) return Response.json({ error: `API-Football HTTP ${response.status}`, apiRequests }, { status: response.status });
    if (!payload) return Response.json({ error: 'API-FootballからJSON以外の応答を受信しました', apiRequests }, { status: 502 });
    responses.push({ date, response: fixtureDetails(payload.response).filter((fixture) => fixtureIds.has(String((fixture.fixture as Record<string, unknown> | undefined)?.id)))});
  }

  const createdAt = new Date().toISOString();
  const rawSnapshot = { format: 'api-football-fixtures-date-v1', responses };
  const fixtures = resultFixtureRecords(rawSnapshot);
  const statisticsAvailable = fixtures.filter((fixture) => Array.isArray(fixture.statistics)).length;
  await db.prepare('INSERT INTO result_snapshots (odds_run_id,created_at,api_requests,raw_json) VALUES (?,?,?,?)')
    .bind(body.runId, createdAt, apiRequests, JSON.stringify(rawSnapshot)).run();

  // The raw snapshot is retained even if typed identity or result conversion is unavailable.
  let typed = { saved: 0, existing: 0, skipped: 0, error: 0, conflicts: 0 };
  try {
    typed = await saveTypedResults(db, { capturedAt: createdAt, fixtures });
  } catch (error) {
    typed.error = 1;
    console.error('typed result dual-write failed; raw result snapshot remains saved', error);
  }
  return Response.json({ saved: true, runId: body.runId, createdAt, apiRequests, fixtures: fixtures.length, statisticsAvailable, typed });
}

export async function GET(request: Request) {
  const runId = new URL(request.url).searchParams.get('runId');
  const db = (env as unknown as { DB: D1Database }).DB;
  await ensureRuntimeSchema(db);
  const row = runId
    ? await db.prepare('SELECT created_at,api_requests,raw_json FROM result_snapshots WHERE odds_run_id=? ORDER BY created_at DESC LIMIT 1').bind(runId).first<{ created_at: string; api_requests: number; raw_json: string }>()
    : null;
  const raw = row ? JSON.parse(row.raw_json) : null;
  return Response.json({ result: row ? { createdAt: row.created_at, apiRequests: row.api_requests, fixtures: resultFixtureRecords(raw).length } : null });
}
