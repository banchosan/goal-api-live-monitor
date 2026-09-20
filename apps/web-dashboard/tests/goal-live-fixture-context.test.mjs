import test from 'node:test';
import assert from 'node:assert/strict';
import { goalLiveFixtureContext } from '../lib/goal-live-fixture-context.ts';

test('LIVE fixture context forwards official GOAL IDs for a later manual Bookmark', () => {
  const context = goalLiveFixtureContext({
    id: 'goal-fixture-1', kickoffUtc: '2026-09-20T12:00:00.000Z', matchStatus: 'LIVE',
    league: { id: 'goal-league-1', name: 'League', country: { name: 'Country' } },
    homeTeam: { id: 'goal-home-1', name: 'Home' }, awayTeam: { id: 'goal-away-1', name: 'Away' },
  });
  assert.deepEqual(context, {
    id: 'goal-fixture-1', kickoffUtc: '2026-09-20T12:00:00.000Z', status: 'LIVE',
    league: 'League', country: 'Country', home: 'Home', away: 'Away', homeScore: '-', awayScore: '-',
    leagueId: 'goal-league-1', homeTeamId: 'goal-home-1', awayTeamId: 'goal-away-1',
  });
});

test('LIVE fixture context does not invent missing official IDs from display names', () => {
  const context = goalLiveFixtureContext({ id: 'goal-fixture-1', leagueName: 'Same League', homeTeamName: 'Same Team', awayTeamName: 'Same Team' });
  assert.equal(context.leagueId, undefined);
  assert.equal(context.homeTeamId, undefined);
  assert.equal(context.awayTeamId, undefined);
});
