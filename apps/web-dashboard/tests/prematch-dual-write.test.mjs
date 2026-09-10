import test from 'node:test';
import assert from 'node:assert/strict';
import { formTypedEligibility, typedOddsPlan, resultTypedEligibility, saveTypedOdds } from '../lib/prematch-dual-write.ts';

test('form typed eligibility requires an explicit GOAL provider mapping and preserves unmapped raw candidates for the caller', () => {
  const result = formTypedEligibility([
    { teamId: 'goal-1', status: 'success', wins: 4 },
    { teamId: 'goal-2', status: 'success', wins: 3 },
    { teamId: 'goal-3', status: 'http_error' },
  ], new Set(['goal-1']));
  assert.deepEqual(result.map((row) => row.eligible), [true, false, false]);
});

test('typed odds plan reuses normalizer scope and excludes unsupported or malformed values', () => {
  const raw = { response: [{ bookmakers: [{ name: 'Pinnacle', bets: [
    { name: 'Goals Over/Under First Half', values: [{ value: 'Over 1.5', odd: '2.0' }] },
    { name: 'Corners Over Under', values: [{ value: 'Under 9.5', odd: '1.8' }] },
    { name: 'Both Teams To Score', values: [{ value: 'Yes', odd: '1.7' }] },
    { name: 'Asian Handicap', values: [{ value: 'Home -0.5', odd: 'bad' }] },
  ] }] }] };
  const plan = typedOddsPlan('2026-09-10T00:00:00.000Z', [{ apiFixtureId: '42', coreFixtureId: 'goal-api:abc', raw }]);
  assert.deepEqual(plan.candidates.map((value) => [value.period, value.statType, value.side]), [['FIRST_HALF', 'GOALS', 'OVER'], ['FULL_TIME', 'CORNERS', 'UNDER']]);
  assert.equal(plan.unsupported, 1);
  assert.equal(plan.malformed, 1);
});

test('typed result eligibility accepts final result facts only and never treats unfinished scores as typed facts', () => {
  const finished = resultTypedEligibility({ fixture: { id: 7, status: { short: 'FT' } }, goals: { home: 2, away: 1 }, score: { halftime: { home: 1, away: 0 } } });
  assert.equal(finished.valid, true);
  assert.equal(finished.home, 2);
  const unfinished = resultTypedEligibility({ fixture: { id: 8, status: { short: '2H' } }, goals: { home: 1, away: 1 } });
  assert.equal(unfinished.valid, false);
  const malformed = resultTypedEligibility({ fixture: { id: 9, status: { short: 'FT' } }, goals: { home: null, away: 1 } });
  assert.equal(malformed.valid, false);
});

test('typed odds capture uses one batch so a failed typed write leaves no partial capture in a synthetic DB', async () => {
  const db = {
    batchCalls: 0,
    prepare(sql) {
      return {
        bind: (...values) => ({
          first: async () => sql.startsWith('SELECT id FROM odds_capture_runs_v2') ? null : null,
          sql, values,
        }),
      };
    },
    async batch() { this.batchCalls += 1; throw new Error('synthetic batch failure'); },
  };
  const raw = { response: [{ bookmakers: [{ name: 'P', bets: [{ name: 'Match Winner', values: [{ value: 'Home', odd: '2' }] }] }] }] };
  await assert.rejects(() => saveTypedOdds(db, { legacyRunId: 'raw-run', capturedAt: '2026-09-10T00:00:00Z', apiRequests: 1, sources: [{ apiFixtureId: '1', coreFixtureId: 'core-1', raw }], raw }), /synthetic batch failure/);
  assert.equal(db.batchCalls, 1);
});
