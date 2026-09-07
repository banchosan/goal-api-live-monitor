export const dynamic = 'force-dynamic';
import { fetchAllLiveFixtures } from '../../../lib/live-fixtures';

type RawFixture = Record<string, unknown>;

function stringValue(value: unknown, fallback: string): string {
  return value === null || value === undefined ? fallback : String(value);
}

export async function GET() {
  const apiKey = process.env.GOAL_API_KEY;
  if (!apiKey) return Response.json({ error: 'GOAL_API_KEYが未設定です' }, { status: 500 });
  try {
    const result = await fetchAllLiveFixtures(apiKey);
    const fixtures = result.fixtures.map((f: RawFixture) => {
      const league = f.league && typeof f.league === 'object' ? f.league as RawFixture : {};
      const leagueCountry = league.country && typeof league.country === 'object' ? league.country as RawFixture : {};
      const homeTeam = f.homeTeam && typeof f.homeTeam === 'object' ? f.homeTeam as RawFixture : {};
      const awayTeam = f.awayTeam && typeof f.awayTeam === 'object' ? f.awayTeam as RawFixture : {};
      return {
        id: stringValue(f.id ?? f.fixture_id ?? f.fixtureId, ''),
        league: stringValue(f.leagueName ?? league.name ?? f.league_name, 'Unknown league'),
        country: stringValue(f.countryName ?? leagueCountry.name ?? f.country_name, ''),
        home: stringValue(f.homeTeamName ?? homeTeam.name ?? f.match_hometeam_name, 'Home'),
        away: stringValue(f.awayTeamName ?? awayTeam.name ?? f.match_awayteam_name, 'Away'),
        homeScore: stringValue(f.homeTeamScore ?? f.match_hometeam_score, '-'),
        awayScore: stringValue(f.awayTeamScore ?? f.match_awayteam_score, '-'),
        status: stringValue(f.matchStatus ?? f.match_status ?? f.status, 'LIVE'),
        kickoffUtc: stringValue(f.kickoffUtc ?? f.kickoff_utc, new Date().toISOString()),
      };
    });
    console.info(`GOAL API /fixtures called ${result.apiCalls} time(s) to assemble ${fixtures.length} unique LIVE/HALF_TIME fixtures`);
    return Response.json(
      { fixtures, apiRequests: result.apiCalls, pages: result.pages, warnings: result.errors },
      { headers: { 'X-GoalApi-Calls': String(result.apiCalls) } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'GOAL API request failed';
    return Response.json({ error: message }, { status: 502 });
  }
}
