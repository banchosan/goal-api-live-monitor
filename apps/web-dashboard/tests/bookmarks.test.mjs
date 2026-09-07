import test from 'node:test'; import assert from 'node:assert/strict';
import { isBookmarkStatus, normalizeBookmarkInput } from '../lib/bookmarks.ts';

const valid = { fixtureId:'f1',home:'Home',away:'Away',league:'League',country:'JP',kickoffUtc:'2026-09-07T12:00:00Z' };
test('Bookmark input is normalized',()=>{const row=normalizeBookmarkInput(valid);assert.equal(row.fixtureId,'f1');assert.equal(row.kickoffUtc,'2026-09-07T12:00:00.000Z');assert.equal(row.reason,'manual')});
test('Bookmark requires fixture identity and valid kickoff',()=>{assert.throws(()=>normalizeBookmarkInput({...valid,fixtureId:''}),/fixtureId/);assert.throws(()=>normalizeBookmarkInput({...valid,kickoffUtc:'bad'}),/kickoffUtc/)});
test('Bookmark status is restricted',()=>{for(const s of ['waiting','monitoring','finished','removed'])assert.equal(isBookmarkStatus(s),true);assert.equal(isBookmarkStatus('subscribing'),false)});
