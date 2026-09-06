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

test('returns fixtures from the healthy status when the other status fails', async () => {
  const calls = [];
  const result = await fetchAllLiveFixtures('secret', async (input) => {
    const status = new URL(input).searchParams.get('status'); calls.push(status);
    if (status === 'LIVE') throw new Error('upstream unavailable');
    return { ok: true, status: 200, json: async () => ({ data: [fixture('ht-1')], pagination: { hasMore: false } }) };
  });
  assert.deepEqual(result.fixtures.map((item) => item.id), ['ht-1']);
  assert.deepEqual(calls, ['LIVE', 'HALF_TIME']);
  assert.deepEqual(result.errors, [{ status: 'LIVE', offset: 0, reason: 'upstream unavailable' }]);
});

test('fails clearly after both statuses fail instead of returning a false zero', async () => {
  let calls = 0;
  await assert.rejects(() => fetchAllLiveFixtures('secret', async () => { calls += 1; throw new Error('502'); }), /LIVE@0 502.*HALF_TIME@0 502/);
  assert.equal(calls, 2);
});

test('aborts stalled requests and always settles', async () => {
  let calls = 0;
  const stalledFetch = (_input, init) => new Promise((_resolve, reject) => {
    calls += 1;
    init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
  });
  await assert.rejects(() => fetchAllLiveFixtures('secret', stalledFetch, { requestTimeoutMs: 5 }), /timeout/);
  assert.equal(calls, 2);
});
