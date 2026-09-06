import test from 'node:test';
import assert from 'node:assert/strict';
import { displayMatchMinute } from '../lib/live-minute.ts';

test('shows an exact numeric provider minute', () => {
  assert.equal(displayMatchMinute('67'), "67'");
  assert.equal(displayMatchMinute('45+3'), "45+3'");
});

test('never presents generic LIVE as an exact minute', () => {
  assert.equal(displayMatchMinute('LIVE'), "--'（Socket分数待ち）");
  assert.equal(displayMatchMinute(''), "--'（Socket分数待ち）");
});

test('keeps explicit half-time and full-time states', () => {
  assert.equal(displayMatchMinute('HALF_TIME'), 'HT');
  assert.equal(displayMatchMinute('FINISHED'), 'FT');
});
