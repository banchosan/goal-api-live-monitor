import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateFormCandidate, toChronologicalResults } from '../lib/form-candidate-rules.ts';

function evaluate(sequence) {
  const results = [...sequence].map((result) => ({ result }));
  return evaluateFormCandidate({
    results,
    played: results.length,
    wins: results.filter(({ result }) => result === 'W').length,
    draws: results.filter(({ result }) => result === 'D').length,
  });
}

test('normalizes provider newest-first results to chronological order', () => {
  assert.deepEqual(toChronologicalResults(['newest', 'middle', 'oldest']), ['oldest', 'middle', 'newest']);
});

test('excludes a base-qualified team ending L-L', () => {
  const result = evaluate('WWWLL');
  // Three wins and no draw does not satisfy the unchanged base rule, while
  // the recent-two rule independently identifies the L-L ending.
  assert.equal(result.baseQualified, false);
  assert.equal(result.qualified, false);
  assert.equal(result.recentTwoExcluded, true);
  assert.equal(result.exclusionCode, 'LL');
});

test('excludes a base-qualified team ending D-L', () => {
  const result = evaluate('WWWDL');
  assert.equal(result.baseQualified, true);
  assert.equal(result.qualified, false);
  assert.equal(result.exclusionCode, 'DL');
});

test('excludes a base-qualified team ending L-D', () => {
  const result = evaluate('WWWLD');
  assert.equal(result.baseQualified, true);
  assert.equal(result.qualified, false);
  assert.equal(result.exclusionCode, 'LD');
});

test('keeps a four-win team ending W-L', () => {
  assert.equal(evaluate('WWWWL').qualified, true);
});

test('keeps a three-win two-draw team ending D-D', () => {
  assert.equal(evaluate('WWWDD').qualified, true);
});

test('keeps a five-win team', () => {
  assert.equal(evaluate('WWWWW').qualified, true);
});

test('includes a five-match team on a current three-win streak even after two losses', () => {
  const result = evaluate('LLWWW');
  assert.equal(result.baseQualified, false);
  assert.equal(result.recentThreeWins, true);
  assert.equal(result.qualified, true);
});

test('does not treat a three-win streak as valid without a complete five-match window', () => {
  const result = evaluate('LWWW');
  assert.equal(result.recentThreeWins, false);
  assert.equal(result.qualified, false);
});

test('insufficient results are not a candidate and are not marked as recent-form excluded', () => {
  const result = evaluate('WL');
  assert.equal(result.baseQualified, false);
  assert.equal(result.qualified, false);
  assert.equal(result.recentTwoExcluded, false);
  assert.equal(result.exclusionReason, null);
});
