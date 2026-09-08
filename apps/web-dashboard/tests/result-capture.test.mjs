import test from 'node:test';
import assert from 'node:assert/strict';
import { analysisDownloadFilename, chunkFixtureIds, detailForAnalysis, resultFixtureRecords } from '../lib/result-capture.ts';

test('fixtures ids are batched at the documented 20-fixture maximum', () => {
  assert.equal(chunkFixtureIds(Array.from({ length: 15 }, (_, index) => index + 1)).length, 1);
  assert.deepEqual(chunkFixtureIds(Array.from({ length: 30 }, (_, index) => index + 1)).map((batch) => batch.length), [20, 10]);
});

test('analysis detail keeps final, halftime, statistics and raw provider fields separate', () => {
  const detail = detailForAnalysis({ fixture: { id: 7, status: { short: 'FT' } }, goals: { home: 2, away: 1 }, score: { halftime: { home: 1, away: 0 }, fulltime: { home: 2, away: 1 } }, statistics: [{ team: { name: 'Home' }, statistics: [{ type: 'Expected Goals', value: '1.23' }] }] });
  assert.equal(detail.apiFixtureId, 7);
  assert.deepEqual(detail.firstHalfResult, { home: 1, away: 0 });
  const statistics = detail.statistics;
  assert.equal(statistics[0].statistics[0].type, 'Expected Goals');
});

test('analysis export filename is generated in JST at download time', () => {
  assert.equal(analysisDownloadFilename(new Date('2026-09-08T12:35:20.000Z')), 'football-analysis_2026-09-08_21-35-20_JST.json');
});

test('legacy date-grouped result snapshots remain readable in AI exports', () => {
  assert.equal(resultFixtureRecords([{ date: '2026-09-08', response: [{ fixture: { id: 7 } }] }]).length, 1);
});
