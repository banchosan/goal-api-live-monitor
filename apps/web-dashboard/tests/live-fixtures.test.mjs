import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchAllLiveFixtures } from '../lib/live-fixtures.ts';

function fixture(id) { return { id }; }
function fakeFetch(pages) {
  const calls = [];
  const fetchImpl = async (input) => {
    const url = new URL(input);
    const key = `${url.searchParams.get('status')}:${url.searchParams.get('offset')}`;
    calls.push(key);
    const body = pages[key];
    if (!body) throw new Error(`Unexpected request ${key}`);
    return { ok: true, status: 200, json: async () => body };
  };
  return { calls, fetchImpl };
}

test('includes both LIVE and HALF_TIME fixtures and deduplicates by fixture id', async () => {
  const { calls, fetchImpl } = fakeFetch({
    'LIVE:0': { data: [fixture('live-1'), fixture('shared')], pagination: { total: 2, limit: 100, offset: 0, hasMore: false } },
    'HALF_TIME:0': { data: [fixture('ht-1'), fixture('shared')], pagination: { total: 2, limit: 100, offset: 0, hasMore: false } },
  });
  const result = await fetchAllLiveFixtures('secret', fetchImpl);
  assert.deepEqual(result.fixtures.map((item) => item.id), ['live-1', 'shared', 'ht-1']);
  assert.deepEqual(calls, ['LIVE:0', 'HALF_TIME:0']);
  assert.equal(result.apiCalls, 2);
});

test('uses pagination.hasMore instead of assuming a short page is final', async () => {
  const { calls, fetchImpl } = fakeFetch({
    'LIVE:0': { data: [fixture('live-1')], pagination: { total: 2, limit: 100, offset: 0, hasMore: true } },
    'LIVE:100': { data: [fixture('live-2')], pagination: { total: 2, limit: 100, offset: 100, hasMore: false } },
    'HALF_TIME:0': { data: [], pagination: { total: 0, limit: 100, offset: 0, hasMore: false } },
  });
  const result = await fetchAllLiveFixtures('secret', fetchImpl);
  assert.deepEqual(result.fixtures.map((item) => item.id), ['live-1', 'live-2']);
  assert.deepEqual(calls, ['LIVE:0', 'LIVE:100', 'HALF_TIME:0']);
});

test('continues beyond the previous three-page ceiling', async () => {
  const pages = { 'HALF_TIME:0': { data: [], pagination: { total: 0, limit: 100, offset: 0, hasMore: false } } };
  for (let page = 0; page < 4; page += 1) {
    const offset = page * 100;
    pages[`LIVE:${offset}`] = {
      data: [fixture(`page-${page}`)],
      pagination: { total: 301, limit: 100, offset, hasMore: page < 3 },
    };
  }
  const { calls, fetchImpl } = fakeFetch(pages);
  const result = await fetchAllLiveFixtures('secret', fetchImpl);
  assert.equal(result.fixtures.length, 4);
  assert.deepEqual(calls, ['LIVE:0', 'LIVE:100', 'LIVE:200', 'LIVE:300', 'HALF_TIME:0']);
});
