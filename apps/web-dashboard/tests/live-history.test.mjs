import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLiveHistoryDetail, historyStatus } from '../lib/live-history.ts';

const fixture = (id = 'goal-api:fixture-1') => ({ fixtureId: id, providerFixtureId: id.replace('goal-api:', ''), home: 'Home', away: 'Away', kickoffUtc: '2026-09-14T12:00:00.000Z' });
const snapshot = (minute, status, values = {}) => ({ fixture_id: 'goal-api:fixture-1', source_client_event_id: `event-${status}-${minute}`, provider_event_key: `key-${status}-${minute}`, captured_at: `2026-09-14T12:${String(Math.min(minute ?? 0, 59)).padStart(2, '0')}:00.000Z`, elapsed_minute: minute, added_time: null, match_status: status, home_score: 0, away_score: 0, shots_home: null, shots_away: null, shots_on_target_home: null, shots_on_target_away: null, corners_home: null, corners_away: null, attacks_home: null, attacks_away: null, dangerous_attacks_home: null, dangerous_attacks_away: null, yellow_cards_home: null, yellow_cards_away: null, red_cards_home: null, red_cards_away: null, saves_home: null, saves_away: null, passes_total_home: null, passes_total_away: null, passes_accurate_home: null, passes_accurate_away: null, possession_home: null, possession_away: null, ...values });

test('completed fixtures remain available as D1-history details without collector session input', () => {
  const detail = buildLiveHistoryDetail(fixture(), [snapshot(1, '1'), snapshot(45, 'HT', { dangerous_attacks_home: 23, dangerous_attacks_away: 9 }), snapshot(61, '61', { dangerous_attacks_home: 31, dangerous_attacks_away: 24 }), snapshot(90, 'FINISHED', { home_score: 4, away_score: 1 })], [{ id: 'signal-1', ruleId: 'dangerous_attacks_ht_increase', ruleVersion: 'v1', signalSide: 'AWAY', triggeredAt: '2026-09-14T13:01:00.000Z', detectedMinute: 61, ruleParameters: { thresholdValue: 15 }, feature: { htHomeDangerousAttacks: 23, htAwayDangerousAttacks: 9, currentHomeDangerousAttacks: 31, currentAwayDangerousAttacks: 24, awayDaIncrease: 15 } }]);
  assert.equal(detail.status, 'finished');
  assert.equal(detail.actualHtObserved, true);
  assert.equal(detail.signals.length, 1);
  assert.equal(detail.signals[0].signalSide, 'AWAY');
  assert.equal(detail.checkpoints.find((row) => row.target === 'HT').dangerousAttacksAway, 9);
  assert.equal(detail.checkpoints.find((row) => row.target === 65).dangerousAttacksAway, 24);
});

test('Ludogorets regression detail uses the causal HT and 65 checkpoints with no signal', () => {
  const detail = buildLiveHistoryDetail(fixture(), [snapshot(1, '1'), snapshot(45, 'HT', { dangerous_attacks_home: 32, dangerous_attacks_away: 21 }), snapshot(55, '55', { dangerous_attacks_home: 39, dangerous_attacks_away: 24 }), snapshot(60, '60', { dangerous_attacks_home: 42, dangerous_attacks_away: 27 }), snapshot(65, '65', { dangerous_attacks_home: 44, dangerous_attacks_away: 29 }), snapshot(90, 'FINISHED')], []);
  assert.equal(detail.snapshotCount, 6);
  assert.equal(detail.checkpoints.find((row) => row.target === 'HT').dangerousAttacksHome, 32);
  assert.equal(detail.checkpoints.find((row) => row.target === 65).dangerousAttacksAway, 29);
  assert.equal(detail.signals.length, 0);
});

test('Braga regression detail shows its persisted HT and 65 values', () => {
  const detail = buildLiveHistoryDetail(fixture(), [snapshot(45, 'HT', { dangerous_attacks_home: 27, dangerous_attacks_away: 7 }), snapshot(65, '65', { dangerous_attacks_home: 31, dangerous_attacks_away: 13 }), snapshot(89, '89')], []);
  assert.equal(detail.actualHtObserved, true);
  assert.equal(detail.checkpoints.find((row) => row.target === 'HT').dangerousAttacksHome, 27);
  assert.equal(detail.checkpoints.find((row) => row.target === 65).dangerousAttacksAway, 13);
});

test('a missing actual HT remains missing instead of being inferred from minute 45', () => {
  const detail = buildLiveHistoryDetail(fixture(), [snapshot(45, '45', { dangerous_attacks_home: 20, dangerous_attacks_away: 10 }), snapshot(60, '60')], []);
  assert.equal(detail.actualHtObserved, false);
  const ht = detail.checkpoints.find((row) => row.target === 'HT');
  assert.equal(ht.insufficient, true);
  assert.equal(ht.dangerousAttacksHome, null);
});

test('history preserves null statistics and incomplete fixtures', () => {
  const detail = buildLiveHistoryDetail(fixture(), [snapshot(25, '25', { dangerous_attacks_home: null, dangerous_attacks_away: 0 }), snapshot(31, '31', { dangerous_attacks_home: null, dangerous_attacks_away: 3 })], []);
  assert.equal(detail.status, 'incomplete');
  assert.equal(detail.lastSnapshotMinute, 31);
  assert.equal(detail.checkpoints.find((row) => row.target === 25).dangerousAttacksHome, null);
  assert.equal(detail.checkpoints.find((row) => row.target === 25).dangerousAttacksAway, 0);
  assert.equal(historyStatus('FINISHED'), 'finished');
  assert.equal(historyStatus('31'), 'incomplete');
});
