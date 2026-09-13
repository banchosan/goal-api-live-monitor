import test from 'node:test';import assert from 'node:assert/strict';
import {ODDS_BATCH_SIZE,splitOddsBatch,uniqueByFixtureId} from '../lib/odds-batching.ts';
test('46 fixtures are safely split into 40 plus 6',()=>{const items=Array.from({length:46},(_,i)=>({fixtureId:`f${i}`})),first=splitOddsBatch(items);assert.equal(ODDS_BATCH_SIZE,40);assert.equal(first.batch.length,40);assert.equal(first.remaining.length,6);assert.equal(splitOddsBatch(first.remaining).batch.length,6)});
test('100 fixtures split without losing identity and duplicate fixture candidates are removed',()=>{const items=Array.from({length:100},(_,i)=>({fixtureId:`f${i}`}));assert.equal(splitOddsBatch(items).batch.length,40);assert.equal(uniqueByFixtureId([...items,{fixtureId:'f0'}]).length,100)});
