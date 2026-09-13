import test from 'node:test';
import assert from 'node:assert/strict';
import { autoLeagueEligibility, validateGoalFixture, writeGoalFixtureIdentity } from '../lib/goal-auto-form.ts';

const fixture = { providerFixtureId:'g-fixture-1', kickoffUtc:'2026-09-20T12:00:00Z', leagueId:'cmr77dvkr005nrx06lp7rvp49', leagueName:'Premier League', country:'England', homeTeamId:'100', awayTeamId:'200', homeTeamName:'Home', awayTeamName:'Away' };

function fakeDb({ mappedHome='legacy-core-home', mappedAway='legacy-core-away', mappedFixture=null, conflict=false }={}) {
  const calls=[]; let batches=0;
  return {
    prepare(sql) { let values=[]; return { bind(...args){ values=args; return this; }, async first(){
      if (sql.includes('FROM team_provider_ids')) { const id=values[0]; if(id==='100') return {team_id:mappedHome,core_id:mappedHome}; if(id==='200') return {team_id:mappedAway,core_id:mappedAway}; return null; }
      if (sql.includes('FROM core_leagues')) return null;
      if (sql.includes('FROM fixture_provider_ids')) return mappedFixture ? {fixture_id:mappedFixture} : null;
      if (sql.includes('FROM core_fixtures')) return mappedFixture ? {id:mappedFixture,kickoff_utc:conflict?'2026-09-21T12:00:00.000Z':'2026-09-20T12:00:00.000Z',home_team_id:mappedHome,away_team_id:mappedAway,league_id:'goal-api:cmr77dvkr005nrx06lp7rvp49'} : null;
      if (sql.includes('FROM core_teams')) return null;
      return null;
    }, _sql:sql, _values:()=>values }; },
    async batch(statements){ batches++; calls.push(...statements); }, get batches(){return batches}, calls,
  };
}

test('allowlist is provider-ID based and rejects unknown/missing IDs',()=>{
  assert.equal(autoLeagueEligibility(fixture).eligible,true);
  assert.equal(autoLeagueEligibility({...fixture,leagueId:''}).reason,'UNRESOLVED_LEAGUE_ID');
  assert.equal(autoLeagueEligibility({...fixture,leagueId:'not-observed'}).reason,'LEAGUE_NOT_ALLOWLISTED');
  assert.equal(autoLeagueEligibility({...fixture,leagueName:'Different'}).reason,'LEAGUE_METADATA_CONFLICT');
});
test('strict fixture validation rejects incomplete or self-opponent payload',()=>{
  assert.equal(validateGoalFixture({...fixture,homeTeamId:''}),'missing_home_team_id');
  assert.equal(validateGoalFixture({...fixture,kickoffUtc:'bad'}),'invalid_kickoff');
  assert.equal(validateGoalFixture({...fixture,awayTeamId:'100'}),'same_home_away_team');
});
test('existing GOAL mapping is canonical even when it is not the natural ID',async()=>{
  const db=fakeDb(); const result=await writeGoalFixtureIdentity(db,fixture);
  assert.equal(result.status,'CREATED'); assert.equal(db.batches,1);
  assert.equal(db.calls.filter(x=>x._sql.includes('INSERT INTO core_teams')).length,0);
  const insertedFixture=db.calls.find(x=>x._sql.includes('INSERT INTO core_fixtures'));
  assert.deepEqual(insertedFixture._values().slice(2,4),['legacy-core-home','legacy-core-away']);
});
test('identical mapped fixture is no-op and conflicting mapped fixture is fail-closed',async()=>{
  const same=await writeGoalFixtureIdentity(fakeDb({mappedFixture:'existing'}),fixture); assert.equal(same.status,'EXISTING');
  const conflictDb=fakeDb({mappedFixture:'existing',conflict:true}); const conflict=await writeGoalFixtureIdentity(conflictDb,fixture);
  assert.equal(conflict.status,'CONFLICT'); assert.equal(conflictDb.batches,0);
});
test('a missing GOAL provider mapping creates provider-scoped teams, never name merges',async()=>{
  const db=fakeDb({mappedHome:null,mappedAway:null});
  const input={...fixture,homeTeamId:'300',awayTeamId:'400',homeTeamName:'Same Name',awayTeamName:'Same Name'};
  const result=await writeGoalFixtureIdentity(db,input);
  assert.equal(result.status,'CREATED'); assert.equal(db.batches,1);
  assert.equal(db.calls.filter(x=>x._sql.includes('INSERT INTO core_teams')).length,2);
  const maps=db.calls.filter(x=>x._sql.includes('INSERT INTO team_provider_ids'));
  assert.equal(maps.length,2);
  assert.deepEqual(maps.map(x=>x._values()[2]).sort(),['goal-api:300','goal-api:400']);
});
