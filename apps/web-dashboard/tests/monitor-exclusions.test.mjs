import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMonitorExclusionInput } from '../lib/monitor-exclusions.ts';

test('monitor exclusion input is normalized independently from Bookmark', () => {
  assert.deepEqual(normalizeMonitorExclusionInput({ fixtureId:' f1 ',home:' Home ',away:'Away',reason:'' }), {
    fixtureId:'f1',home:'Home',away:'Away',reason:'manual_monitor_remove',
  });
});

test('monitor exclusion requires fixtureId', () => {
  assert.throws(() => normalizeMonitorExclusionInput({ fixtureId:'' }), /fixtureId/);
});
