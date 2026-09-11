import test from 'node:test';
import assert from 'node:assert/strict';
import { isGoalProviderPlaceholderZeroPair } from '../lib/live-stat-availability.ts';
import { normalizeGoalLiveSnapshot } from '../lib/goal-live-normalizer.ts';

test('marks long-running 0-0 attack placeholders as provider-unavailable, not real zero', () => {
  assert.equal(isGoalProviderPlaceholderZeroPair('Attacks', '0', '0', '74'), true);
  assert.equal(isGoalProviderPlaceholderZeroPair('Dangerous Attacks', 0, 0, '15'), true);
  assert.equal(isGoalProviderPlaceholderZeroPair('Corners', 0, 0, '74'), false);
  assert.equal(isGoalProviderPlaceholderZeroPair('Attacks', 0, 0, '9'), false);
  assert.equal(isGoalProviderPlaceholderZeroPair('Attacks', 0, 1, '74'), false);
});

test('typed projection keeps raw statistics but nulls only unavailable attack placeholders', () => {
  const snapshot = normalizeGoalLiveSnapshot({ fixtureId: 'fixture', receivedAt: '2026-09-11T11:34:00.000Z', clientEventId: 'event', payloadHash: 'hash', payload: { data: { match_status: '74', statistics: [{ type: 'Attacks', home: '0', away: '0' }, { type: 'Dangerous Attacks', home: '0', away: '0' }, { type: 'Corners', home: '0', away: '0' }] } } }, 'goal-api:fixture');
  assert.ok(snapshot);
  assert.equal(snapshot.attacksHome, null); assert.equal(snapshot.attacksAway, null);
  assert.equal(snapshot.dangerousAttacksHome, null); assert.equal(snapshot.dangerousAttacksAway, null);
  assert.equal(snapshot.cornersHome, 0); assert.equal(snapshot.cornersAway, 0);
  assert.equal(snapshot.rawStatistics.length, 3);
});

test('one-sided true zero stays a numeric measurement', () => {
  const snapshot = normalizeGoalLiveSnapshot({ fixtureId: 'fixture', receivedAt: '2026-09-11T11:34:00.000Z', clientEventId: 'event', payloadHash: 'hash', payload: { data: { match_status: '74', statistics: [{ type: 'Attacks', home: '0', away: '31' }] } } }, 'goal-api:fixture');
  assert.ok(snapshot);
  assert.equal(snapshot.attacksHome, 0); assert.equal(snapshot.attacksAway, 31);
});
