import test from 'node:test'; import assert from 'node:assert/strict';
import { canTransitionBookmarkStatus, isBookmarkStatus, normalizeBookmarkInput } from '../lib/bookmarks.ts';

const valid = { fixtureId:'f1',home:'Home',away:'Away',league:'League',country:'JP',kickoffUtc:'2026-09-07T12:00:00Z' };
test('Bookmark input is normalized',()=>{const row=normalizeBookmarkInput(valid);assert.equal(row.fixtureId,'f1');assert.equal(row.kickoffUtc,'2026-09-07T12:00:00.000Z');assert.equal(row.reason,'manual')});
test('Bookmark preserves official GOAL IDs when the upcoming payload supplies them',()=>{const row=normalizeBookmarkInput({...valid,leagueId:'league-1',homeTeamId:'home-1',awayTeamId:'away-1'});assert.equal(row.leagueId,'league-1');assert.equal(row.homeTeamId,'home-1');assert.equal(row.awayTeamId,'away-1')});
test('Bookmark requires fixture identity and valid kickoff',()=>{assert.throws(()=>normalizeBookmarkInput({...valid,fixtureId:''}),/fixtureId/);assert.throws(()=>normalizeBookmarkInput({...valid,kickoffUtc:'bad'}),/kickoffUtc/)});
test('Bookmark status is restricted',()=>{for(const s of ['waiting','monitoring','finished','removed'])assert.equal(isBookmarkStatus(s),true);assert.equal(isBookmarkStatus('subscribing'),false)});
test('a delayed monitoring update cannot reopen a finished Bookmark',()=>{assert.equal(canTransitionBookmarkStatus('finished','monitoring'),false);assert.equal(canTransitionBookmarkStatus('monitoring','finished'),true);assert.equal(canTransitionBookmarkStatus('waiting','monitoring'),true)});
