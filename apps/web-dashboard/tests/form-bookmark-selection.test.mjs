import test from 'node:test';
import assert from 'node:assert/strict';
import { formQualifiedFixtureIds, qualifiedUnbookmarkedFixtures } from '../lib/form-bookmark-selection.ts';

test('bulk Bookmark includes only fixtures with at least one qualified form side', () => {
  const fixtures = [{ id: 'good-home' }, { id: 'good-away' }, { id: 'poor' }];
  const candidates = [{ fixtureId: 'good-home' }, { fixtureId: 'good-home' }, { fixtureId: 'good-away' }];
  assert.deepEqual([...formQualifiedFixtureIds(candidates)], ['good-home', 'good-away']);
  assert.deepEqual(qualifiedUnbookmarkedFixtures(fixtures, candidates, []), [{ id: 'good-home' }, { id: 'good-away' }]);
});

test('already bookmarked qualified fixtures are excluded without admitting poor-form fixtures', () => {
  const fixtures = [{ id: 'good' }, { id: 'poor' }];
  const candidates = [{ fixtureId: 'good' }];
  assert.deepEqual(qualifiedUnbookmarkedFixtures(fixtures, candidates, [{ fixtureId: 'good' }]), []);
});
