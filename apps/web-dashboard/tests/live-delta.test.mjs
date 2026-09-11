import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateLiveDelta, inspectLiveSnapshotQuality, resolveCheckpoint } from '../lib/live-delta.ts';

const snapshot = (minute, values = {}) => ({
  fixture_id: 'fixture-1', source_client_event_id: `event-${minute}-${values.suffix ?? ''}`, provider_event_key: `key-${minute}-${values.suffix ?? ''}`,
  captured_at: values.captured_at ?? `2026-09-10T20:${String(minute).padStart(2, '0')}:00.000Z`, elapsed_minute: minute,
  match_status: values.match_status ?? String(minute), home_score: 0, away_score: 0,
  shots_home: 0, shots_away: 0, shots_on_target_home: 0, shots_on_target_away: 0,
  corners_home: 0, corners_away: 0, attacks_home: 0, attacks_away: 0,
  dangerous_attacks_home: 0, dangerous_attacks_away: 0, yellow_cards_home: 0, yellow_cards_away: 0,
  red_cards_home: 0, red_cards_away: 0, saves_home: 0, saves_away: 0,
  passes_total_home: 0, passes_total_away: 0, passes_accurate_home: 0, passes_accurate_away: 0,
  possession_home: 50, possession_away: 50, ...values,
});

test('calculates independent cumulative deltas and pressure differential', () => {
  const result = calculateLiveDelta([
    snapshot(60, { shots_home: 8, shots_away: 2, shots_on_target_home: 3, shots_on_target_away: 1, corners_home: 2, corners_away: 0, dangerous_attacks_home: 35, dangerous_attacks_away: 10 }),
    snapshot(70, { shots_home: 14, shots_away: 3, shots_on_target_home: 6, shots_on_target_away: 1, corners_home: 5, corners_away: 0, dangerous_attacks_home: 53, dangerous_attacks_away: 14 }),
  ], 60, 70);
  assert.equal(result.sufficient, true); assert.equal(result.home.shots.delta, 6); assert.equal(result.away.shots.delta, 1);
  assert.equal(result.home.corners.delta, 3); assert.equal(result.pressure.shots, 5); assert.equal(result.pressure.dangerousAttacks, 14);
});

test('keeps NULL distinct from zero', () => {
  const nullStart = calculateLiveDelta([snapshot(60, { corners_home: null }), snapshot(70, { corners_home: 3 })], 60, 70);
  const zeroStart = calculateLiveDelta([snapshot(60, { corners_home: 0 }), snapshot(70, { corners_home: 3 })], 60, 70);
  assert.equal(nullStart.home.corners.delta, null); assert.equal(zeroStart.home.corners.delta, 3);
});

test('checkpoint never looks ahead and honors tolerance', () => {
  const rows = [snapshot(59), snapshot(61), snapshot(68), snapshot(71)];
  assert.equal(resolveCheckpoint(rows, 60).actualMinute, 59);
  assert.equal(resolveCheckpoint(rows, 70).actualMinute, 68);
  const missing = resolveCheckpoint([snapshot(52)], 60, 5);
  assert.equal(missing.insufficient, true); assert.equal(missing.reason, 'outside_tolerance');
  assert.equal(resolveCheckpoint([snapshot(61)], 60).reason, 'no_snapshot_at_or_before_target');
});

test('half time uses an explicit status and added time remains distinguishable', () => {
  const ht = snapshot(45, { match_status: 'HT', added_time: 2 });
  const result = resolveCheckpoint([snapshot(45, { match_status: '45+2', added_time: 2 }), ht], 'HT');
  assert.equal(result.snapshot, ht); assert.equal(result.actualMinute, 45);
});

test('cumulative decreases are anomalies, not negative deltas', () => {
  const result = calculateLiveDelta([snapshot(60, { shots_home: 10 }), snapshot(70, { shots_home: 8 })], 60, 70);
  assert.equal(result.home.shots.delta, null); assert.equal(result.home.shots.anomaly, 'cumulative_decrease');
  assert.equal(result.anomalies.some((item) => item.field === 'shots' && item.side === 'home'), true);
});

test('possession is level change rather than cumulative pressure', () => {
  const result = calculateLiveDelta([snapshot(60, { possession_home: 42 }), snapshot(70, { possession_home: 55 })], 60, 70);
  assert.deepEqual(result.home.possession, { start: 42, end: 55, change: 13 });
});

test('duplicate and out-of-order input are inspectable without changing causal checkpoint selection', () => {
  const rows = [snapshot(70, { shots_home: 8, captured_at: '2026-09-10T20:02:00.000Z' }), snapshot(60, { shots_home: 10, captured_at: '2026-09-10T20:01:00.000Z' }), snapshot(70, { suffix: 'duplicate', shots_home: 8, captured_at: '2026-09-10T20:02:00.000Z', provider_event_key: 'key-70-' })];
  const quality = inspectLiveSnapshotQuality(rows);
  assert.equal(quality.outOfOrderInput, 1); assert.equal(quality.duplicates, 1);
  assert.equal(quality.cumulativeDecreases.some((item) => item.field === 'shots'), true);
  assert.equal(resolveCheckpoint(rows, 65).actualMinute, 60);
});
