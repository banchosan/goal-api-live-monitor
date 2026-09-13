import { env } from 'cloudflare:workers';
import { ensureRuntimeSchema } from '@/db/schema';
import { fetchTeamResults, TEAM_RESULTS_CONCURRENCY } from '@/lib/team-results-client';
import { evaluateFormCandidate, toChronologicalResults } from '@/lib/form-candidate-rules';
import { saveTypedFormObservations } from '@/lib/prematch-dual-write';
import { autoLeagueEligibility, writeGoalFixtureIdentity, type GoalFixtureInput } from '@/lib/goal-auto-form';

export const dynamic = 'force-dynamic';

const BATCH_SIZE = TEAM_RESULTS_CONCURRENCY;

type InputFixture = {
  id: string; league: string; country: string; home: string; away: string;
  leagueId?: string;
  homeTeamId: string; awayTeamId: string; kickoffUtc: string; kickoffJst: string;
};

type TeamTask = { teamId: string; team: string; side: 'home' | 'away'; opponent: string; fixture: InputFixture };

async function saveAnalysis(payload: { runId:string;createdAt:string;checkedTeams:number;failedTeams:number;apiRequests:number;candidates:unknown;checked:unknown }) {
  const db = (env as unknown as { DB: D1Database }).DB;
  await ensureRuntimeSchema(db);
  await db.prepare(`INSERT INTO form_analysis_runs
    (run_id, created_at, checked_teams, failed_teams, api_requests, candidates_json, checked_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(payload.runId,payload.createdAt,payload.checkedTeams,payload.failedTeams,payload.apiRequests,JSON.stringify(payload.candidates),JSON.stringify(payload.checked)).run();
}

type AutoSummary = { eligible: number; created: number; existing: number; bookmarked: number; skipped: Record<string, number>; conflicts: number };
const skip = (summary: AutoSummary, reason: string) => { summary.skipped[reason] = (summary.skipped[reason] ?? 0) + 1; };

/**
 * Runs strictly after raw form history is committed.  A typed identity failure
 * can never discard a form run.  Every graph write is done by the writer in a
 * single batch; bookmarks are only added after CREATED/EXISTING succeeds.
 */
export async function saveAutoFormBookmarks(db: D1Database, input: { runId: string; selectedAt: string; candidates: Array<Record<string, unknown>> }): Promise<AutoSummary> {
  const summary: AutoSummary = { eligible: 0, created: 0, existing: 0, bookmarked: 0, skipped: {}, conflicts: 0 };
  const byFixture = new Map<string, Record<string, unknown>>();
  for (const candidate of input.candidates) if (candidate.fixtureId) byFixture.set(String(candidate.fixtureId), candidate);
  for (const candidate of byFixture.values()) {
    const fixture: GoalFixtureInput = {
      providerFixtureId: String(candidate.fixtureId ?? ''), kickoffUtc: String(candidate.kickoffUtc ?? ''), leagueId: String(candidate.leagueId ?? ''),
      leagueName: String(candidate.league ?? ''), country: String(candidate.country ?? ''), homeTeamId: String(candidate.homeTeamId ?? ''), awayTeamId: String(candidate.awayTeamId ?? ''),
      homeTeamName: String(candidate.home ?? ''), awayTeamName: String(candidate.away ?? ''),
    };
    const league = autoLeagueEligibility(fixture);
    if (!league.eligible) { skip(summary, league.reason); continue; }
    summary.eligible += 1;
    const excluded = await db.prepare('SELECT fixture_id FROM monitor_fixture_exclusions WHERE fixture_id=? AND active=1').bind(fixture.providerFixtureId).first<{ fixture_id: string }>();
    if (excluded) { skip(summary, 'EXCLUDED'); continue; }
    const identity = await writeGoalFixtureIdentity(db, fixture);
    if (identity.status === 'REJECTED') { skip(summary, identity.reason); continue; }
    if (identity.status === 'CONFLICT') { summary.conflicts += 1; skip(summary, identity.reason); continue; }
    if (identity.status === 'CREATED') summary.created += 1; else summary.existing += 1;
    const existing = await db.prepare('SELECT fixture_id,status,monitor_source FROM fixture_bookmarks WHERE fixture_id=?').bind(fixture.providerFixtureId).first<{ fixture_id: string; status: string; monitor_source: string }>();
    // A manually removed or manually created bookmark is intentional user
    // state. Never reactivate/overwrite it from AUTO_FORM.
    if (existing) { skip(summary, existing.status === 'removed' ? 'BOOKMARK_REMOVED' : 'BOOKMARK_EXISTS'); continue; }
    await db.prepare(`INSERT INTO fixture_bookmarks (fixture_id,home,away,league,country,kickoff_utc,bookmarked_at,reason,related_team_id,related_team_name,status,monitor_source,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,'waiting','auto_form',?)`).bind(
      fixture.providerFixtureId, fixture.homeTeamName || 'Home', fixture.awayTeamName || 'Away', fixture.leagueName || '', fixture.country || '', fixture.kickoffUtc,
      input.selectedAt, `auto_form;form_run:${input.runId};core_fixture:${identity.coreFixtureId}`, String(candidate.teamId ?? ''), String(candidate.team ?? ''), input.selectedAt,
    ).run();
    summary.bookmarked += 1;
  }
  return summary;
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
        // GOAL API /teams/:id/results is newest-first. Keep the same five
        // fixtures, then normalize to oldest-first so the rightmost result is
        // consistently the most recent one in storage, UI and rule evaluation.
        const results = toChronologicalResults(fetched.data.map((match: Record<string, any>) => resultForTeam(match, task.teamId)).filter(Boolean).slice(0, 5));
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

  const evaluated = checked.map((team) => {
    if (team.status !== 'success') return team;
    return { ...team, formEvaluation: evaluateFormCandidate(team) };
  });
  checked.splice(0, checked.length, ...evaluated);

  const excludedByRecentForm = checked.filter((team) => team.formEvaluation?.baseQualified && team.formEvaluation.recentTwoExcluded).map((team) => ({
    teamId: team.teamId,
    team: team.team,
    fixtureId: team.fixture.id,
    home: team.fixture.home,
    away: team.fixture.away,
    homeTeamId: team.fixture.homeTeamId,
    awayTeamId: team.fixture.awayTeamId,
    recentTwo: team.formEvaluation.recentTwo,
    exclusionCode: team.formEvaluation.exclusionCode,
    exclusionReason: team.formEvaluation.exclusionReason,
  }));

  const candidates = checked.filter((team) => team.formEvaluation?.qualified).map((team) => ({
    kickoffUtc: team.fixture.kickoffUtc,
    kickoffJst: team.fixture.kickoffJst,
    league: team.fixture.league,
    leagueId: team.fixture.leagueId ?? '',
    country: team.fixture.country,
    fixtureId: team.fixture.id,
    // Candidate odds and the cross-provider bridge require the original fixture
    // context. These are required identity fields, not display-only values.
    home: team.fixture.home,
    away: team.fixture.away,
    homeTeamId: team.fixture.homeTeamId,
    awayTeamId: team.fixture.awayTeamId,
    teamId: team.teamId,
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
  // Raw history is the source of truth. Typed conversion is deliberately best-effort
  // and is never allowed to turn a successful collection into a failed one.
  let typed = { saved: 0, existing: 0, skipped: 0, error: 0 };
  if (saved) try {
    const db = (env as unknown as { DB: D1Database }).DB;
    typed = await saveTypedFormObservations(db, { runId, observedAt: createdAt, checked });
  } catch (error) {
    typed.error = 1;
    console.error('typed form dual-write failed; raw form run remains saved', error);
  }
  let autoForm: AutoSummary | null = null;
  if (saved) try {
    const db = (env as unknown as { DB: D1Database }).DB;
    autoForm = await saveAutoFormBookmarks(db, { runId, selectedAt: createdAt, candidates });
  } catch (error) {
    // Raw history is preserved even if a local DB write has an infrastructure
    // failure. The failure is visible in the response instead of becoming a
    // silent partial AUTO admission.
    console.error('AUTO_FORM identity/bookmark write failed; raw form run remains saved', error);
    autoForm = { eligible: 0, created: 0, existing: 0, bookmarked: 0, skipped: { AUTO_WRITE_ERROR: 1 }, conflicts: 0 };
  }
  return Response.json({ candidates, excludedByRecentForm, excludedCount: excludedByRecentForm.length, checkedTeams: checked.length, failedTeams, apiRequests, retryCount, outcomeCounts, runId, saved, typed, autoForm });
}
