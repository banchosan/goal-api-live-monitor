import test from 'node:test';import assert from 'node:assert/strict';
import {displayOddsUnmatched,fixturesFromOddsRunPayload,oddsFixtureLookupResponses,oddsUnmatched} from '../lib/odds-run-payload.ts';
const day={date:'2026-09-13',payload:{response:[{fixture:{id:1},league:{name:'League'}}]}};
test('legacy array odds run remains readable',()=>{assert.equal(fixturesFromOddsRunPayload(JSON.stringify([day])).length,1);assert.equal(oddsFixtureLookupResponses(JSON.stringify([day])).length,1)});
test('resumable batched odds run remains readable by odds and analysis pages',()=>{const raw=JSON.stringify({format:'candidate-odds-batched-v1',fixtureResponses:[day],completedGoalFixtureIds:['goal-1']});assert.equal(fixturesFromOddsRunPayload(raw)[0].fixture.id,1);assert.equal(oddsFixtureLookupResponses(raw).length,1)});
test('invalid and non-array unmatched payloads never crash a history page',()=>{assert.deepEqual(oddsUnmatched('{bad'),[]);assert.deepEqual(oddsUnmatched('{}'),[])});
test('internal fixture contexts are flattened before React renders unmatched teams',()=>{const raw=JSON.stringify([{id:'goal-1',home:{id:'h',name:'Home'},away:{id:'a',name:'Away'},league:'League'}]);assert.deepEqual(displayOddsUnmatched(raw),[{fixtureId:'goal-1',home:'Home',away:'Away',league:'League',country:''}])});
