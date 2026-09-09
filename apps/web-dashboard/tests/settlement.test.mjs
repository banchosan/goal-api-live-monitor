import test from 'node:test';
import assert from 'node:assert/strict';
import { settleAsianHandicap, settleMoneyline, settleTotalGoals } from '../lib/settlement.ts';

test('settles moneyline outcomes', () => {
  assert.deepEqual(settleMoneyline(2, 1, 1.8), { outcome: 'WIN', profitUnits: 0.8 });
  assert.deepEqual(settleMoneyline(1, 1, 1.8), { outcome: 'PUSH', profitUnits: 0 });
});

test('settles Asian Handicap quarter lines', () => {
  assert.deepEqual(settleAsianHandicap(1, 1, -0.25, 2), { outcome: 'HALF_LOSS', profitUnits: -0.5 });
  assert.deepEqual(settleAsianHandicap(2, 1, -0.75, 2), { outcome: 'HALF_WIN', profitUnits: 0.5 });
  assert.deepEqual(settleAsianHandicap(3, 1, -1, 1.8), { outcome: 'WIN', profitUnits: 0.8 });
});

test('settles Over/Under quarter lines', () => {
  assert.deepEqual(settleTotalGoals(3, 'OVER', 2.75, 2), { outcome: 'HALF_WIN', profitUnits: 0.5 });
  assert.deepEqual(settleTotalGoals(3, 'UNDER', 3.25, 2), { outcome: 'HALF_WIN', profitUnits: 0.5 });
  assert.deepEqual(settleTotalGoals(3, 'OVER', 3, 2), { outcome: 'PUSH', profitUnits: 0 });
});
