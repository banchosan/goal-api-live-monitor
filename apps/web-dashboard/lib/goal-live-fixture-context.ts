/**
 * Carries only official GOAL identifiers from a LIVE `/fixtures` payload.
 * Missing IDs deliberately stay undefined: identity must never be guessed from
 * a team or league name.
 */
export type GoalLiveFixtureContext = {
  id: string;
  league: string;
  country: string;
  home: string;
  away: string;
  homeScore: string;
  awayScore: string;
  status: string;
  kickoffUtc: string;
  leagueId?: string;
  homeTeamId?: string;
  awayTeamId?: string;
};

type RawFixture = Record<string, unknown>;

function object(value: unknown): RawFixture {
  return value && typeof value === 'object' ? value as RawFixture : {};
}

function text(value: unknown, fallback = ''): string {
  return value === null || value === undefined ? fallback : String(value);
}

function optionalId(value: unknown): string | undefined {
  const id = text(value).trim();
  return id || undefined;
}

/**
 * This is a transport mapper, not an identity resolver.  The only IDs it
 * forwards are fields supplied directly by GOAL's LIVE fixture payload.
 */
export function goalLiveFixtureContext(raw: RawFixture): GoalLiveFixtureContext {
  const league = object(raw.league);
  const leagueCountry = object(league.country);
  const homeTeam = object(raw.homeTeam);
  const awayTeam = object(raw.awayTeam);
  return {
    id: text(raw.id ?? raw.fixture_id ?? raw.fixtureId),
    league: text(raw.leagueName ?? league.name ?? raw.league_name, 'Unknown league'),
    country: text(raw.countryName ?? leagueCountry.name ?? raw.country_name),
    home: text(raw.homeTeamName ?? homeTeam.name ?? raw.match_hometeam_name, 'Home'),
    away: text(raw.awayTeamName ?? awayTeam.name ?? raw.match_awayteam_name, 'Away'),
    homeScore: text(raw.homeTeamScore ?? raw.match_hometeam_score, '-'),
    awayScore: text(raw.awayTeamScore ?? raw.match_awayteam_score, '-'),
    status: text(raw.matchStatus ?? raw.match_status ?? raw.status, 'LIVE'),
    kickoffUtc: text(raw.kickoffUtc ?? raw.kickoff_utc, new Date().toISOString()),
    leagueId: optionalId(raw.leagueId ?? league.id ?? raw.league_id),
    homeTeamId: optionalId(raw.homeTeamId ?? homeTeam.id ?? raw.match_hometeam_id),
    awayTeamId: optionalId(raw.awayTeamId ?? awayTeam.id ?? raw.match_awayteam_id),
  };
}
