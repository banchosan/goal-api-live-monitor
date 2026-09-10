import { matchFixturePair, type FixtureContext } from './fixture-identity-bridge.ts';

type Provider = 'goal-api' | 'api-football';
type CoreFixture = { id: string; homeTeamId: string | null; awayTeamId: string | null };
type Team = { id: string; name: string };
export type IdentitySaveResult = { status: 'saved' | 'noop'; coreFixtureId: string; evidence: string[] } | { status: 'skipped' | 'conflict'; reason: string };
const coreId = (provider: Provider, externalId: string) => `${provider}:${externalId}`;
const capturedAt = () => new Date().toISOString();

async function fixtureMapping(db: D1Database, provider: Provider, externalId: string) { return (await db.prepare('SELECT fixture_id FROM fixture_provider_ids WHERE provider=? AND external_fixture_id=?').bind(provider, externalId).first<{ fixture_id: string }>())?.fixture_id ?? null; }
async function teamMapping(db: D1Database, provider: Provider, externalId: string) { return (await db.prepare('SELECT team_id FROM team_provider_ids WHERE provider=? AND external_team_id=?').bind(provider, externalId).first<{ team_id: string }>())?.team_id ?? null; }
async function providerIdsForTeam(db: D1Database, provider: Provider, teamId: string) { return ((await db.prepare('SELECT external_team_id FROM team_provider_ids WHERE provider=? AND team_id=?').bind(provider, teamId).all<{ external_team_id: string }>()).results ?? []).map((row) => row.external_team_id); }
async function coreFixture(db: D1Database, id: string) { return await db.prepare('SELECT id,home_team_id AS homeTeamId,away_team_id AS awayTeamId FROM core_fixtures WHERE id=?').bind(id).first<CoreFixture>(); }

async function resolveTeam(db: D1Database, goal: Team, api: Team, country?: string) {
  const [goalCore, apiCore] = await Promise.all([teamMapping(db, 'goal-api', goal.id), teamMapping(db, 'api-football', api.id)]);
  if (goalCore && apiCore && goalCore !== apiCore) return { conflict: `provider team mappings disagree for ${goal.name}` } as const;
  const id = goalCore ?? apiCore ?? coreId('goal-api', goal.id);
  const [apiIds, goalIds] = await Promise.all([providerIdsForTeam(db, 'api-football', id), providerIdsForTeam(db, 'goal-api', id)]);
  if (apiIds.some((value) => value !== api.id)) return { conflict: `GOAL team ${goal.id} already maps to another API-Football team` } as const;
  if (goalIds.some((value) => value !== goal.id)) return { conflict: `API-Football team ${api.id} already maps to another GOAL team` } as const;
  return { id, create: !goalCore && !apiCore, addGoal: !goalCore, addApi: !apiCore, goal, api, country } as const;
}

/** A single D1 batch is used only after all provider and orientation checks pass. */
export async function saveSafeFixtureIdentity(db: D1Database, goal: FixtureContext, api: FixtureContext): Promise<IdentitySaveResult> {
  const bridge = matchFixturePair(goal, api);
  if (bridge.status !== 'SAFE_MATCH') return { status: 'skipped', reason: `${bridge.status}: ${bridge.reason}` };
  if (!goal.home.id || !goal.away.id || !api.home.id || !api.away.id) return { status: 'skipped', reason: 'fixture is missing provider team IDs' };
  const [goalFixture, apiFixture] = await Promise.all([fixtureMapping(db, 'goal-api', goal.id), fixtureMapping(db, 'api-football', api.id)]);
  if (goalFixture && apiFixture && goalFixture !== apiFixture) return { status: 'conflict', reason: 'fixture provider mappings point to different core fixtures' };
  const [home, away] = await Promise.all([resolveTeam(db, goal.home, api.home, goal.country), resolveTeam(db, goal.away, api.away, goal.country)]);
  if ('conflict' in home) return { status: 'conflict', reason: home.conflict };
  if ('conflict' in away) return { status: 'conflict', reason: away.conflict };
  const fixtureId = goalFixture ?? apiFixture ?? coreId('goal-api', goal.id);
  const existing = await coreFixture(db, fixtureId);
  if (existing && ((existing.homeTeamId && existing.homeTeamId !== home.id) || (existing.awayTeamId && existing.awayTeamId !== away.id))) return { status: 'conflict', reason: 'core fixture home/away identity conflicts with SAFE pair' };
  const now = capturedAt(), evidence = JSON.stringify({ bridgeEvidence: bridge.evidence, bridgeVersion: 1 });
  const statements: D1PreparedStatement[] = [];
  for (const item of [home, away]) {
    if (item.create) statements.push(db.prepare('INSERT INTO core_teams (id,name,country,created_at,updated_at) VALUES (?,?,?,?,?)').bind(item.id, item.goal.name, item.country ?? null, now, now));
    if (item.addGoal) statements.push(db.prepare('INSERT INTO team_provider_ids (provider,external_team_id,team_id,provider_payload_json,first_seen_at,last_seen_at) VALUES (?,?,?,?,?,?)').bind('goal-api', item.goal.id, item.id, JSON.stringify({ name: item.goal.name }), now, now));
    if (item.addApi) statements.push(db.prepare('INSERT INTO team_provider_ids (provider,external_team_id,team_id,provider_payload_json,first_seen_at,last_seen_at) VALUES (?,?,?,?,?,?)').bind('api-football', item.api.id, item.id, JSON.stringify({ name: item.api.name }), now, now));
  }
  if (!existing) statements.push(db.prepare('INSERT INTO core_fixtures (id,kickoff_utc,home_team_id,away_team_id,league_id,home_name,away_name,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)').bind(fixtureId, goal.kickoffUtc, home.id, away.id, null, goal.home.name, goal.away.name, now, now));
  else if (!existing.homeTeamId || !existing.awayTeamId) statements.push(db.prepare('UPDATE core_fixtures SET home_team_id=?,away_team_id=?,updated_at=? WHERE id=?').bind(home.id, away.id, now, fixtureId));
  if (!goalFixture) statements.push(db.prepare('INSERT INTO fixture_provider_ids (provider,external_fixture_id,fixture_id,provider_payload_json,first_seen_at,last_seen_at) VALUES (?,?,?,?,?,?)').bind('goal-api', goal.id, fixtureId, evidence, now, now));
  if (!apiFixture) statements.push(db.prepare('INSERT INTO fixture_provider_ids (provider,external_fixture_id,fixture_id,provider_payload_json,first_seen_at,last_seen_at) VALUES (?,?,?,?,?,?)').bind('api-football', api.id, fixtureId, evidence, now, now));
  if (!statements.length) return { status: 'noop', coreFixtureId: fixtureId, evidence: bridge.evidence };
  await db.batch(statements);
  return { status: 'saved', coreFixtureId: fixtureId, evidence: bridge.evidence };
}
