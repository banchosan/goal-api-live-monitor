/**
 * GOAL-only identity and AUTO_FORM admission.  This deliberately never
 * queries API-Football and never compares teams or fixtures by their names.
 */
export type GoalFixtureInput = {
  providerFixtureId: string; kickoffUtc: string; leagueId: string; leagueName?: string; country?: string;
  homeTeamId: string; awayTeamId: string; homeTeamName?: string; awayTeamName?: string; season?: string; round?: string;
};
export type GoalIdentityResult =
 | { status: 'CREATED' | 'EXISTING'; coreFixtureId: string }
 | { status: 'CONFLICT' | 'REJECTED'; reason: string };

// IDs below are observed in local GOAL raw payloads with the exact country/name
// shown. Scottish Premiership remains intentionally absent until a raw provider
// payload proves its ID; no league is admitted by name alone.
export const GOAL_AUTO_LEAGUES: Record<string, { name: string; country: string }> = {
  'cmr77dvkr005nrx06lp7rvp49': { name: 'Premier League', country: 'England' },
  'cmr77dvkr005hrx068xaahpuh': { name: 'Championship', country: 'England' },
  'cmr77dvnt006nrx063v3w622e': { name: 'La Liga', country: 'Spain' },
  'cmr77dvnt006orx06io7l06lv': { name: 'Segunda División', country: 'Spain' },
  'cmr77dvgm0002rx06rt2uqxii': { name: 'Bundesliga', country: 'Germany' },
  'cmr77dvgm0001rx060h6ivt4p': { name: '2. Bundesliga', country: 'Germany' },
  'cmr77dvpd006yrx06zig7907g': { name: 'Serie A', country: 'Italy' },
  'cmr77dvpd006zrx06dmggkel8': { name: 'Serie B', country: 'Italy' },
  'cmr77dvqg007crx06q1kaceyo': { name: 'Ligue 1', country: 'France' },
  'cmr77dvqg007drx06q6y56j5u': { name: 'Ligue 2', country: 'France' },
  'cmr77dvrh007vrx0664phtxs5': { name: 'Eredivisie', country: 'Netherlands' },
  'cmr77dw9g00gvrx06jlglb47m': { name: 'First Division A', country: 'Belgium' },
  'cmr77dvun00adrx06xz20yfxe': { name: 'Primeira Liga', country: 'Portugal' },
  'cmr77dw0q00eprx06rqew3m48': { name: 'Süper Lig', country: 'Turkey' },
};

const id = (kind: string, value: string) => `${kind}:${value}`;
const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const canonicalTime = (value: string) => { const ms = Date.parse(value); return Number.isFinite(ms) ? new Date(ms).toISOString() : null; };

export function autoLeagueEligibility(input: Pick<GoalFixtureInput, 'leagueId' | 'leagueName' | 'country'>) {
  const league = GOAL_AUTO_LEAGUES[text(input.leagueId)];
  if (!text(input.leagueId)) return { eligible: false, reason: 'UNRESOLVED_LEAGUE_ID' };
  if (!league) return { eligible: false, reason: 'LEAGUE_NOT_ALLOWLISTED' };
  // Provider ID is the authorization key; metadata must still agree when
  // present so that corrupted/mixed payloads cannot silently enter AUTO.
  if (text(input.leagueName) && text(input.leagueName) !== league.name) return { eligible: false, reason: 'LEAGUE_METADATA_CONFLICT' };
  if (text(input.country) && text(input.country) !== league.country) return { eligible: false, reason: 'LEAGUE_METADATA_CONFLICT' };
  return { eligible: true as const, league };
}

export function validateGoalFixture(input: GoalFixtureInput): string | null {
  if (!text(input.providerFixtureId)) return 'missing_fixture_id';
  if (!text(input.homeTeamId)) return 'missing_home_team_id';
  if (!text(input.awayTeamId)) return 'missing_away_team_id';
  if (!text(input.leagueId)) return 'missing_league_id';
  if (!canonicalTime(input.kickoffUtc)) return 'invalid_kickoff';
  if (text(input.homeTeamId) === text(input.awayTeamId)) return 'same_home_away_team';
  return null;
}

type TeamRow = { team_id: string; core_id?: string | null };
type FixtureRow = { fixture_id: string };
type CoreFixture = { id: string; kickoff_utc: string | null; home_team_id: string | null; away_team_id: string | null; league_id: string | null };

async function one<T>(db: D1Database, sql: string, ...args: unknown[]) { return db.prepare(sql).bind(...args).first<T>(); }
async function resolveTeam(db: D1Database, externalId: string, name: string, country: string | undefined, now: string) {
  const found = await one<TeamRow>(db, `SELECT p.team_id, t.id AS core_id FROM team_provider_ids p
    LEFT JOIN core_teams t ON t.id=p.team_id WHERE p.provider='goal-api' AND p.external_team_id=?`, externalId);
  if (found && !found.core_id) return { conflict: 'team_identity_conflict' } as const;
  if (found) return { id: found.team_id, statements: [] as D1PreparedStatement[] } as const;
  const teamId = id('goal-api', externalId);
  const existing = await one<{ id: string }>(db, 'SELECT id FROM core_teams WHERE id=?', teamId);
  const statements: D1PreparedStatement[] = [];
  if (!existing) statements.push(db.prepare('INSERT INTO core_teams (id,name,country,created_at,updated_at) VALUES (?,?,?,?,?)').bind(teamId, name || `GOAL team ${externalId}`, country ?? null, now, now));
  statements.push(db.prepare('INSERT INTO team_provider_ids (provider,external_team_id,team_id,provider_payload_json,first_seen_at,last_seen_at) VALUES (?,?,?,?,?,?)').bind('goal-api', externalId, teamId, JSON.stringify({ name }), now, now));
  return { id: teamId, statements } as const;
}

/** Writes a complete GOAL-only fixture graph in one batch after all checks. */
export async function writeGoalFixtureIdentity(db: D1Database, input: GoalFixtureInput): Promise<GoalIdentityResult> {
  const rejected = validateGoalFixture(input); if (rejected) return { status: 'REJECTED', reason: rejected };
  const now = new Date().toISOString(), kickoff = canonicalTime(input.kickoffUtc)!;
  const [home, away] = await Promise.all([resolveTeam(db, text(input.homeTeamId), text(input.homeTeamName), input.country, now), resolveTeam(db, text(input.awayTeamId), text(input.awayTeamName), input.country, now)]);
  if ('conflict' in home || 'conflict' in away) return { status: 'CONFLICT', reason: 'team_identity_conflict' };
  const leagueId = id('goal-api', text(input.leagueId));
  const league = await one<{ id: string }>(db, 'SELECT id FROM core_leagues WHERE id=?', leagueId);
  const mapped = await one<FixtureRow>(db, 'SELECT fixture_id FROM fixture_provider_ids WHERE provider=? AND external_fixture_id=?', 'goal-api', text(input.providerFixtureId));
  if (mapped) {
    const existing = await one<CoreFixture>(db, 'SELECT id,kickoff_utc,home_team_id,away_team_id,league_id FROM core_fixtures WHERE id=?', mapped.fixture_id);
    if (!existing) return { status: 'CONFLICT', reason: 'dangling_fixture_mapping' };
    const same = canonicalTime(existing.kickoff_utc ?? '') === kickoff && existing.home_team_id === home.id && existing.away_team_id === away.id && existing.league_id === leagueId;
    return same ? { status: 'EXISTING', coreFixtureId: existing.id } : { status: 'CONFLICT', reason: 'fixture_context_conflict' };
  }
  const fixtureId = id('goal-api', text(input.providerFixtureId));
  const preexisting = await one<CoreFixture>(db, 'SELECT id,kickoff_utc,home_team_id,away_team_id,league_id FROM core_fixtures WHERE id=?', fixtureId);
  if (preexisting && (canonicalTime(preexisting.kickoff_utc ?? '') !== kickoff || preexisting.home_team_id !== home.id || preexisting.away_team_id !== away.id || preexisting.league_id !== leagueId)) return { status: 'CONFLICT', reason: 'core_fixture_context_conflict' };
  const statements = [...home.statements, ...away.statements];
  if (!league) statements.push(db.prepare('INSERT INTO core_leagues (id,name,country,created_at,updated_at) VALUES (?,?,?,?,?)').bind(leagueId, text(input.leagueName) || `GOAL league ${input.leagueId}`, input.country ?? null, now, now));
  if (!preexisting) statements.push(db.prepare('INSERT INTO core_fixtures (id,kickoff_utc,home_team_id,away_team_id,league_id,home_name,away_name,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)').bind(fixtureId,kickoff,home.id,away.id,leagueId,text(input.homeTeamName) || 'Home',text(input.awayTeamName) || 'Away',now,now));
  statements.push(db.prepare('INSERT INTO fixture_provider_ids (provider,external_fixture_id,fixture_id,provider_payload_json,first_seen_at,last_seen_at) VALUES (?,?,?,?,?,?)').bind('goal-api',text(input.providerFixtureId),fixtureId,JSON.stringify(input),now,now));
  await db.batch(statements);
  return { status: 'CREATED', coreFixtureId: fixtureId };
}
