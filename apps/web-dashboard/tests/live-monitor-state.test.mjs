import test from 'node:test';
import assert from 'node:assert/strict';
import { visibleCollectorFixtures, withoutFixture } from '../lib/live-monitor-state.ts';

test('finished fixture can be removed from dashboard without mutating historical data', () => {
  const historicalEvents = [{ fixtureId: 'finished', eventType: 'match_update' }];
  const visible = withoutFixture({ finished: { id: 'finished', ended: true }, live: { id: 'live' } }, 'finished');
  assert.deepEqual(Object.keys(visible), ['live']);
  assert.equal(historicalEvents.length, 1);
});

test('hidden fixture is not restored by collector status polling', () => {
  const fixtures = [{ id: 'finished' }, { id: 'live' }];
  assert.deepEqual(visibleCollectorFixtures(fixtures, new Set(['finished'])), [{ id: 'live' }]);
});
