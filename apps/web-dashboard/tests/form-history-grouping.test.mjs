import test from 'node:test';
import assert from 'node:assert/strict';
import { countryFlag, groupFormCandidates } from '../lib/form-history-grouping.ts';

test('five major countries stay first and remaining countries are alphabetical', () => {
  const groups = groupFormCandidates([
    { fixtureId: '1', team: 'Portugal', country: 'Portugal', league: 'Primeira Liga' }, { fixtureId: '2', team: 'France', country: 'France', league: 'Ligue 1' }, { fixtureId: '3', team: 'England', country: 'England', league: 'Premier League' }, { fixtureId: '4', team: 'Germany', country: 'Germany', league: 'Bundesliga' }, { fixtureId: '5', team: 'Italy', country: 'Italy', league: 'Serie A' }, { fixtureId: '6', team: 'Spain', country: 'Spain', league: 'La Liga' }, { fixtureId: '7', team: 'Argentina', country: 'Argentina', league: 'Primera División' },
  ]);
  assert.deepEqual(groups.map((group) => group.country), ['England', 'Spain', 'Germany', 'Italy', 'France', 'Argentina', 'Portugal']);
});

test('groups leagues alphabetically, preserves candidates, and always supplies a country flag', () => {
  const groups = groupFormCandidates([{ fixtureId: '1', team: 'B', country: 'Sweden', league: 'Superettan', kickoffUtc: '2026-09-20T12:00:00Z' }, { fixtureId: '2', team: 'A', country: 'Sweden', league: 'Allsvenskan', kickoffUtc: '2026-09-20T11:00:00Z' }]);
  assert.equal(groups[0].flag, '🇸🇪');
  assert.deepEqual(groups[0].leagues.map((league) => league.league), ['Allsvenskan', 'Superettan']);
  assert.equal(countryFlag('Unknown provider country'), '🏳️');
});
