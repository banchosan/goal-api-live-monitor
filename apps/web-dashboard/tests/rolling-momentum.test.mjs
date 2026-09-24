import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateRollingMomentum, nextRollingMomentumState, rollingMomentumPoint } from '../../../services/collector/rolling-momentum.mjs';

const point = (minute, attack, da, awayAttack = 40, awayDa = 10) => rollingMomentumPoint([
  { type: 'Attacks', home: String(attack), away: String(awayAttack) },
  { type: 'Dangerous Attacks', home: String(da), away: String(awayDa) },
], minute, `2026-09-22T12:${String(minute).padStart(2, '0')}:00.000Z`);

test('rolling pressure uses only causal ten-minute history and needs both five-minute DA segments', () => {
  const history = [point(46, 20, 10), point(51, 28, 14), point(56, 35, 17)];
  const result = evaluateRollingMomentum(history);
  assert.equal(result.HOME.eligible, true);
  assert.equal(result.HOME.rule, 'rapid_10m');
  assert.equal(result.HOME.startMinute, 46);
  assert.equal(result.HOME.attackDelta, 15);
  assert.equal(result.HOME.opponentAttackDelta, 0);
  assert.equal(result.HOME.daDelta, 7);
  assert.equal(result.HOME.pressureDiff, 7);
  assert.deepEqual([result.HOME.firstFiveDa, result.HOME.lastFiveDa], [4, 3]);
});

test('first-half monitoring can fire at 25 with observed 15→20→25 Socket history', () => {
  const result = evaluateRollingMomentum([point(15, 18, 5), point(20, 27, 9), point(25, 34, 13)]);
  assert.equal(result.phase, 'first_half');
  assert.equal(result.HOME.eligible, true);
  assert.equal(result.HOME.startMinute, 15);
  assert.equal(result.HOME.endMinute, 25);
  assert.equal(result.HOME.attackDelta, 16);
  assert.equal(result.HOME.daDelta, 8);
});

test('a late first-half connection never invents the missing ten-minute baseline', () => {
  const result = evaluateRollingMomentum([point(20, 27, 9), point(25, 34, 13)]);
  assert.equal(result.phase, 'first_half');
  assert.equal(result.HOME.eligible, false);
  assert.equal(result.HOME.reason, 'insufficient_socket_history');
});

test('a prior fire turns faded when the latest five minutes add no DA, without erasing the first fire', () => {
  const active = evaluateRollingMomentum([point(46, 20, 10), point(51, 28, 14), point(56, 35, 17)]).HOME;
  const prior = nextRollingMomentumState(null, active, '2026-09-22T12:56:00.000Z');
  const stopped = evaluateRollingMomentum([point(46, 20, 10), point(51, 28, 14), point(56, 35, 17), point(61, 36, 17)]).HOME;
  const state = nextRollingMomentumState(prior, stopped, '2026-09-22T13:01:00.000Z');
  assert.equal(state.state, 'faded');
  assert.equal(state.firstFiredAtMinute, 56);
});

test('a cumulative DA correction is a quality state, not negative pressure', () => {
  const result = evaluateRollingMomentum([point(46, 20, 10), point(51, 28, 14), point(56, 35, 9)]).HOME;
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'cumulative_correction');
});
