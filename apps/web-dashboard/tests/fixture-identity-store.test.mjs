import test from 'node:test';
import assert from 'node:assert/strict';
import { saveSafeFixtureIdentity } from '../lib/fixture-identity-store.ts';

const goal={id:'goal-fixture',kickoffUtc:'2026-09-10T12:00:00Z',league:'Premier League',country:'England',home:{id:'g-home',name:'Home FC'},away:{id:'g-away',name:'Away FC'}};
const api={id:'api-fixture',kickoffUtc:'2026-09-10T12:00:00Z',league:'Premier League',country:'England',home:{id:'a-home',name:'Home FC'},away:{id:'a-away',name:'Away FC'}};

function db(state={}) {
  const calls=[]; let batches=0;
  const prepare=(sql)=>{let args=[];return {bind(...values){args=values;return this},async first(){if(sql.startsWith('SELECT fixture_id'))return state.fixture?.[`${args[0]}:${args[1]}`]?{fixture_id:state.fixture[`${args[0]}:${args[1]}`]}:null;if(sql.startsWith('SELECT team_id'))return state.team?.[`${args[0]}:${args[1]}`]?{team_id:state.team[`${args[0]}:${args[1]}`]}:null;if(sql.startsWith('SELECT id,home_team_id'))return state.coreFixture?.[args[0]]??null;return null},async all(){if(sql.startsWith('SELECT external_team_id'))return {results:(state.teamRows?.[`${args[0]}:${args[1]}`]??[]).map(external_team_id=>({external_team_id}))};return{results:[]}},_sql:sql,_args:()=>args}};
  return {prepare,batch:async statements=>{batches++;calls.push(...statements);if(state.failBatch)throw new Error('synthetic batch failure')},get batches(){return batches},calls};
}

test('SAFE pair writes all identity facts in one batch',async()=>{const fake=db();const result=await saveSafeFixtureIdentity(fake,goal,api);assert.equal(result.status,'saved');assert.equal(fake.batches,1);assert.equal(fake.calls.filter(x=>x._sql.startsWith('INSERT INTO core_teams')).length,2);assert.equal(fake.calls.filter(x=>x._sql.startsWith('INSERT INTO fixture_provider_ids')).length,2)});
test('same existing SAFE pair is an idempotent no-op',async()=>{const fixture='goal-api:goal-fixture',home='goal-api:g-home',away='goal-api:g-away';const fake=db({fixture:{'goal-api:goal-fixture':fixture,'api-football:api-fixture':fixture},team:{'goal-api:g-home':home,'api-football:a-home':home,'goal-api:g-away':away,'api-football:a-away':away},teamRows:{[`goal-api:${home}`]:['g-home'],[`api-football:${home}`]:['a-home'],[`goal-api:${away}`]:['g-away'],[`api-football:${away}`]:['a-away']},coreFixture:{[fixture]:{id:fixture,homeTeamId:home,awayTeamId:away}}});const result=await saveSafeFixtureIdentity(fake,goal,api);assert.equal(result.status,'noop');assert.equal(fake.batches,0)});
test('mismatch and conflicts never start a batch',async()=>{const mismatch={...api,kickoffUtc:'2026-09-10T12:06:00Z'};const first=db();assert.equal((await saveSafeFixtureIdentity(first,goal,mismatch)).status,'skipped');assert.equal(first.batches,0);const second=db({fixture:{'goal-api:goal-fixture':'one','api-football:api-fixture':'two'}});assert.equal((await saveSafeFixtureIdentity(second,goal,api)).status,'conflict');assert.equal(second.batches,0)});
test('a batch failure cannot leave a second partial write path',async()=>{const fake=db({failBatch:true});await assert.rejects(()=>saveSafeFixtureIdentity(fake,goal,api),/synthetic batch failure/);assert.equal(fake.batches,1);assert.equal(fake.calls.length,9)});
