import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeGoalLiveSnapshot } from '../lib/goal-live-normalizer.ts';

const event = (payload, overrides = {}) => ({
  fixtureId: 'goal-fixture-1', receivedAt: '2026-09-10T20:10:47.223Z', clientEventId: 'session-1:1:goal-fixture-1:match_update',
  providerTimestamp: '123', payloadHash: 'payload-hash-1', payload, ...overrides,
});

test('projects nullable typed live statistics while retaining raw statistics separately', () => {
  const snapshot = normalizeGoalLiveSnapshot(event({ data: { match_status: '70', match_hometeam_score: '2', match_awayteam_score: '1', statistics: [
    { type: 'Shots Total', home: '11', away: '4' }, { type: 'Corners', home: '6', away: '2' }, { type: 'Ball Possession', home: '60%', away: '40%' },
  ] } }), 'goal-api:goal-fixture-1');
  assert.ok(snapshot);
  assert.equal(snapshot.elapsedMinute, 70);
  assert.equal(snapshot.shotsHome, 11);
  assert.equal(snapshot.possessionAway, 40);
  assert.equal(snapshot.dangerousAttacksHome, null);
  assert.equal(snapshot.rawStatistics.length, 3);
});

test('normalizes observed GOAL aliases while preserving zero and null distinctly', () => {
  const snapshot = normalizeGoalLiveSnapshot(event({ data: { match_status: '90+4', match_hometeam_score: '0', match_awayteam_score: 2, statistics: [
    { type: 'Attacks', home: '0', away: '31' }, { type: 'Dangerous Attacks', home: '5', away: '11' },
    { type: 'On Target', home: '3', away: '4' }, { type: 'Yellow Cards', home: '1', away: '0' },
    { type: 'Saves', home: '2', away: '1' }, { type: 'Passes Total', home: '100', away: '99' },
    { type: 'Passes Accurate', home: '88', away: '77' },
  ] } }), 'goal-api:goal-fixture-1');
  assert.ok(snapshot);
  assert.equal(snapshot.elapsedMinute, 90); assert.equal(snapshot.addedTime, 4); assert.equal(snapshot.homeScore, 0);
  assert.equal(snapshot.attacksHome, 0); assert.equal(snapshot.shotsOnTargetAway, 4); assert.equal(snapshot.yellowCardsAway, 0);
  assert.equal(snapshot.passesAccurateHome, 88); assert.equal(snapshot.cornersHome, null);
});

test('malformed values and missing statistics remain null without rejecting a valid match update', () => {
  const snapshot = normalizeGoalLiveSnapshot(event({ data: { match_status: 'HT', match_hometeam_score: 'n/a', statistics: [
    { type: 'Corners', home: 'not-number', away: null }, { type: null, home: '1', away: '2' },
  ] } }), 'goal-api:goal-fixture-1');
  assert.ok(snapshot);
  assert.equal(snapshot.elapsedMinute, null); assert.equal(snapshot.homeScore, null);
  assert.equal(snapshot.cornersHome, null); assert.equal(snapshot.cornersAway, null);
});

test('identity and stable client event are required; duplicate retries preserve the same event key', () => {
  const payload = { data: { match_status: '60', statistics: [] } };
  assert.equal(normalizeGoalLiveSnapshot(event(payload), ''), null);
  assert.equal(normalizeGoalLiveSnapshot(event(payload, { clientEventId: undefined }), 'goal-api:goal-fixture-1'), null);
  const first = normalizeGoalLiveSnapshot(event(payload), 'goal-api:goal-fixture-1');
  const retry = normalizeGoalLiveSnapshot(event(payload), 'goal-api:goal-fixture-1');
  assert.equal(first.providerEventKey, retry.providerEventKey);
  assert.equal(first.sourceClientEventId, retry.sourceClientEventId);
});
