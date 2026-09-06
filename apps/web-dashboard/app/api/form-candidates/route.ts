import { env } from 'cloudflare:workers';
import { monitorSchema } from '@/db/schema';
import { fetchTeamResults, TEAM_RESULTS_CONCURRENCY } from '@/lib/team-results-client';

export const dynamic = 'force-dynamic';

const BATCH_SIZE = TEAM_RESULTS_CONCURRENCY;

type InputFixture = {
  id: string; league: string; country: string; home: string; away: string;
  homeTeamId: string; awayTeamId: string; kickoffUtc: string; kickoffJst: string;
};

type TeamTask = { teamId: string; team: string; side: 'home' | 'away'; opponent: string; fixture: InputFixture };

let schemaReady: Promise<void> | undefined;
async function saveAnalysis(payload: { runId:string;createdAt:string;checkedTeams:number;failedTeams:number;apiRequests:number;candidates:unknown;checked:unknown }) {
  const db = (env as unknown as { DB: D1Database }).DB;
  schemaReady ??= db.batch(monitorSchema.map((statement) => db.prepare(statement))).then(() => undefined);
  await schemaReady;
  await db.prepare(`INSERT INTO form_analysis_runs
    (run_id, created_at, checked_teams, failed_teams, api_requests, candidates_json, checked_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(payload.runId,payload.createdAt,payload.checkedTeams,payload.failedTeams,payload.apiRequests,JSON.stringify(payload.candidates),JSON.stringify(payload.checked)).run();
}

function numberValue(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function resultForTeam(match: Record<string, any>, teamId: string) {
  const homeId = String(match.homeTeamId ?? match.homeTeam?.id ?? '');
  const awayId = String(match.awayTeamId ?? match.awayTeam?.id ?? '');
  const isHome = homeId === teamId;
  if (!isHome && awayId !== teamId) return null;
  const homeScore = numberValue(match.homeTeamFtScore ?? match.homeTeamScore);
  const awayScore = numberValue(match.awayTeamFtScore ?? match.awayTeamScore);
  if (homeScore === null || awayScore === null) return null;
  const won = isHome ? homeScore > awayScore : awayScore > homeScore;
  const drawn = homeScore === awayScore;
  return {
    result: drawn ? 'D' : won ? 'W' : 'L',
    score: `${homeScore}-${awayScore}`,
    opponent: isHome ? (match.awayTeamName ?? match.awayTeam?.name ?? 'Away') : (match.homeTeamName ?? match.homeTeam?.name ?? 'Home'),
    fixtureId: String(match.id ?? ''),
  };
}

export async function POST(request: Request) {
  const apiKey = process.env.GOAL_API_KEY;
  if (!apiKey) return Response.json({ error: 'GOAL_API_KEYが未設定です', apiRequests: 0 }, { status: 500 });

  const body = await request.json().catch(() => null);
  const fixtures: InputFixture[] = Array.isArray(body?.fixtures) ? body.fixtures : [];
  const teams = new Map<string, TeamTask>();
  for (const fixture of fixtures) {
    if (fixture.homeTeamId && !teams.has(fixture.homeTeamId)) teams.set(fixture.homeTeamId, { teamId: fixture.homeTeamId, team: fixture.home, side: 'home', opponent: fixture.away, fixture });
    if (fixture.awayTeamId && !teams.has(fixture.awayTeamId)) teams.set(fixture.awayTeamId, { teamId: fixture.awayTeamId, team: fixture.away, side: 'away', opponent: fixture.home, fixture });
  }
  const tasks = [...teams.values()];
  if (tasks.length > 250) return Response.json({ error: '分析対象が250チームを超えています。リーグを絞り込んでください。', apiRequests: 0 }, { status: 400 });

  let apiRequests = 0;
  const checked: any[] = [];
  for (let index = 0; index < tasks.length; index += BATCH_SIZE) {
    const batch = tasks.slice(index, index + BATCH_SIZE);
    const rows = await Promise.all(batch.map(async (task) => {
      const fetched = await fetchTeamResults({ apiKey, teamId: task.teamId });
      apiRequests += fetched.attempts;
      if (fetched.category !== 'success') {
        return {
          ...task, status: fetched.category, failureCategory: fetched.failureCategory,
          error: fetched.finalError ?? fetched.category, results: [], wins: null, draws: null, played: 0,
          attempts: fetched.attempts, finalHttpStatus: fetched.finalHttpStatus,
          requestStartedAt: fetched.requestStartedAt, requestCompletedAt: fetched.requestCompletedAt,
          dataCount: fetched.dataCount, attemptLog: fetched.attemptLog,
        };
      }
      try {
        const results = fetched.data.map((match: Record<string, any>) => resultForTeam(match, task.teamId)).filter(Boolean).slice(0, 5);
        const wins = results.filter((item: any) => item.result === 'W').length;
        const draws = results.filter((item: any) => item.result === 'D').length;
        return {
          ...task, status: 'success', results, wins, draws, played: results.length, source: fetched.source,
          attempts: fetched.attempts, finalHttpStatus: fetched.finalHttpStatus,
          requestStartedAt: fetched.requestStartedAt, requestCompletedAt: fetched.requestCompletedAt,
          dataCount: fetched.dataCount, attemptLog: fetched.attemptLog,
        };
      } catch (error) {
        return {
          ...task, status: 'parse_error', error: error instanceof Error ? error.message : '解析エラー',
          results: [], wins: null, draws: null, played: 0, attempts: fetched.attempts,
          finalHttpStatus: fetched.finalHttpStatus, requestStartedAt: fetched.requestStartedAt,
          requestCompletedAt: fetched.requestCompletedAt, dataCount: fetched.dataCount, attemptLog: fetched.attemptLog,
        };
      }
    }));
    checked.push(...rows);
  }

  const candidates = checked.filter((team) => team.played === 5 && (team.wins >= 4 || (team.wins === 3 && team.draws >= 1))).map((team) => ({
    kickoffUtc: team.fixture.kickoffUtc,
    kickoffJst: team.fixture.kickoffJst,
    league: team.fixture.league,
    country: team.fixture.country,
    fixtureId: team.fixture.id,
    team: team.team,
    side: team.side,
    opponent: team.opponent,
    last5: team.results,
    wins: team.wins,
    draws: team.draws,
  }));

  const failedTeams = checked.filter((team) => team.status !== 'success').length;
  const retryCount = checked.reduce((sum, team) => sum + Math.max(0, Number(team.attempts ?? 1) - 1), 0);
  const outcomeCounts = checked.reduce((counts, team) => {
    const status = String(team.status ?? 'parse_error');
    counts[status] = (counts[status] ?? 0) + 1;
    return counts;
  }, {} as Record<string, number>);
  const createdAt = new Date().toISOString();
  const runId = `${createdAt}-${crypto.randomUUID()}`;
  let saved = true;
  try { await saveAnalysis({ runId, createdAt, checkedTeams: checked.length, failedTeams, apiRequests, candidates, checked }); }
  catch (error) { saved = false; console.error('form analysis save failed', error); }
  return Response.json({ candidates, checkedTeams: checked.length, failedTeams, apiRequests, retryCount, outcomeCounts, runId, saved });
}
