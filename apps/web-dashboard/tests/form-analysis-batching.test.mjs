import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_FORM_ANALYSIS_TEAMS, splitFormAnalysisBatches } from '../lib/form-analysis-batching.ts';
import { TEAM_RESULTS_CONCURRENCY } from '../lib/team-results-client.ts';

test('expanded 428-team form scope is divided into controlled sequential batches', () => {
  const teams = Array.from({ length: 428 }, (_, index) => `team-${index + 1}`);
  const batches = splitFormAnalysisBatches(teams, TEAM_RESULTS_CONCURRENCY);
  assert.equal(MAX_FORM_ANALYSIS_TEAMS, 500);
  assert.equal(batches.length, Math.ceil(428 / TEAM_RESULTS_CONCURRENCY));
  assert.equal(batches.every((batch) => batch.length <= TEAM_RESULTS_CONCURRENCY), true);
  assert.deepEqual(batches.flat(), teams);
});

test('form batching rejects invalid batch sizes instead of creating unbounded work', () => {
  assert.throws(() => splitFormAnalysisBatches(['team'], 0), /positive integer/);
});
