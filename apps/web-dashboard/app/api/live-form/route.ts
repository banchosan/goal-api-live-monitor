import { env } from 'cloudflare:workers';
import { ensureRuntimeSchema } from '@/db/schema';

export const dynamic = 'force-dynamic';

type SavedTeam = {
  fixture?: { id?: unknown };
  teamId?: unknown;
  team?: unknown;
  side?: unknown;
  status?: unknown;
  results?: unknown;
};

type FormRow = { runId: string; createdAt: string; checkedJson: string };

function text(value: unknown) { return typeof value === 'string' ? value.trim() : String(value ?? '').trim(); }

function lastFive(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.slice(-5).flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const row = item as Record<string, unknown>;
    const result = text(row.result).toUpperCase();
    if (!['W', 'D', 'L'].includes(result)) return [];
    return [{ result, score: text(row.score) || '—', opponent: text(row.opponent) || '—', fixtureId: text(row.fixtureId) }];
  });
}

/**
 * Read-only display projection for the current LIVE board.  Fixture IDs are
 * the only join key; team names are never used to guess a form record.
 */
export async function GET(request: Request) {
  const wanted = [...new Set((new URL(request.url).searchParams.get('fixtureIds') ?? '')
    .split(',').map((id) => id.trim()).filter(Boolean))].slice(0, 25);
  if (!wanted.length) return Response.json({ forms: {} }, { headers: { 'Cache-Control': 'no-store' } });
  const db = (env as unknown as { DB: D1Database }).DB;
  await ensureRuntimeSchema(db);
  const rows = (await db.prepare(`SELECT run_id AS runId, created_at AS createdAt, checked_json AS checkedJson
    FROM form_analysis_runs ORDER BY created_at DESC LIMIT 100`).all<FormRow>()).results ?? [];
  const missing = new Set(wanted);
  const forms: Record<string, { runId: string; createdAt: string; home: unknown[] | null; away: unknown[] | null }> = {};
  const fallback: Record<string, { runId: string; createdAt: string; home: unknown[] | null; away: unknown[] | null }> = {};
  for (const row of rows) {
    if (!missing.size) break;
    let checked: SavedTeam[];
    try { checked = JSON.parse(row.checkedJson); } catch { continue; }
    if (!Array.isArray(checked)) continue;
    const inRun: Record<string, { home: unknown[] | null; away: unknown[] | null }> = {};
    for (const team of checked) {
      const fixtureId = text(team.fixture?.id);
      if (!missing.has(fixtureId) || text(team.status) !== 'success') continue;
      const side = text(team.side).toLowerCase();
      if (side !== 'home' && side !== 'away') continue;
      const results = lastFive(team.results);
      if (!results.length) continue;
      const entry = inRun[fixtureId] ?? { home: null, away: null };
      entry[side] = results;
      inRun[fixtureId] = entry;
    }
    for (const [fixtureId, entry] of Object.entries(inRun)) {
      // Do not mix HOME from one analysis run with AWAY from another. Prefer
      // the newest complete pair; only fall back to a partial same-run record
      // when there is no complete saved analysis for this fixture.
      if (entry.home && entry.away) { forms[fixtureId] = { runId: row.runId, createdAt: row.createdAt, ...entry }; missing.delete(fixtureId); }
      else if (!fallback[fixtureId]) fallback[fixtureId] = { runId: row.runId, createdAt: row.createdAt, ...entry };
    }
  }
  for (const fixtureId of missing) if (fallback[fixtureId]) forms[fixtureId] = fallback[fixtureId];
  return Response.json({ forms }, { headers: { 'Cache-Control': 'no-store' } });
}
