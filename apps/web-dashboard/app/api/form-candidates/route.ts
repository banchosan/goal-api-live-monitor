export const dynamic = 'force-dynamic';

const API_BASE = 'https://api.goal-api.com/v1';
const BATCH_SIZE = 5;

type InputFixture = {
  id: string; league: string; country: string; home: string; away: string;
  homeTeamId: string; awayTeamId: string; kickoffUtc: string; kickoffJst: string;
};

type TeamTask = { teamId: string; team: string; side: 'home' | 'away'; opponent: string; fixture: InputFixture };

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
      apiRequests += 1;
      try {
        const response = await fetch(`${API_BASE}/teams/${encodeURIComponent(task.teamId)}/results?limit=5&offset=0`, {
          headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' }, cache: 'no-store',
        });
        const payload = await response.json();
        if (!response.ok) return { ...task, error: `HTTP ${response.status}`, results: [], wins: null };
        const matches = Array.isArray(payload?.data) ? payload.data : [];
        const results = matches.map((match: Record<string, any>) => resultForTeam(match, task.teamId)).filter(Boolean).slice(0, 5);
        const wins = results.filter((item: any) => item.result === 'W').length;
        const draws = results.filter((item: any) => item.result === 'D').length;
        return { ...task, results, wins, draws, played: results.length, source: payload?.source ?? null };
      } catch (error) {
        return { ...task, error: error instanceof Error ? error.message : '取得エラー', results: [], wins: null };
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

  return Response.json({ candidates, checkedTeams: checked.length, failedTeams: checked.filter((team) => team.error).length, apiRequests });
}
