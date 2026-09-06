import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchTeamResults } from '../lib/team-results-client.ts';

const headers = (values = {}) => new Headers(values);
const response = (status, body, extraHeaders = {}) => ({ ok: status >= 200 && status < 300, status, headers: headers(extraHeaders), text: async () => body });
const clock = () => { let tick = 0; return () => `2026-09-06T00:00:0${tick++}.000Z`; };
const run = (fetchImpl, options = {}) => {
  const sleeps = [];
  return fetchTeamResults({ apiKey: 'secret', teamId: 'team-1', fetchImpl, sleep: async (ms) => { sleeps.push(ms); }, now: clock(), timeoutMs: 10, ...options }).then((result) => ({ result, sleeps }));
};

test('200 JSON success records data and metadata', async () => {
  const { result } = await run(async () => response(200, JSON.stringify({ data: [{ id: 'fixture-1' }], source: 'database' })));
  assert.equal(result.category, 'success'); assert.equal(result.dataCount, 1); assert.equal(result.attempts, 1); assert.equal(result.finalHttpStatus, 200);
});

test('200 with empty data is no_data', async () => {
  const { result } = await run(async () => response(200, JSON.stringify({ data: [] })));
  assert.equal(result.category, 'no_data'); assert.equal(result.dataCount, 0);
});

for (const status of [502, 503, 504]) test(`${status} plain text retries then exhausts`, async () => {
  let calls = 0; const { result, sleeps } = await run(async () => { calls += 1; return response(status, `error code: ${status}`); });
  assert.equal(calls, 3); assert.equal(result.category, 'exhausted_retry'); assert.equal(result.failureCategory, 'http_error'); assert.equal(result.finalHttpStatus, status); assert.equal(result.attemptLog[0].bodyPreview, `error code: ${status}`); assert.deepEqual(sleeps, [500, 1500]);
});

test('network error retries then exhausts', async () => {
  const { result } = await run(async () => { throw new Error('socket unavailable'); });
  assert.equal(result.category, 'exhausted_retry'); assert.equal(result.failureCategory, 'timeout_or_network'); assert.equal(result.attempts, 3);
});

test('timeout retries then exhausts', async () => {
  const error = new Error('aborted'); error.name = 'AbortError';
  const { result } = await run(async () => { throw error; });
  assert.equal(result.category, 'exhausted_retry'); assert.match(result.finalError, /timeout/);
});

test('invalid JSON is parse_error and is not retried', async () => {
  let calls = 0; const { result } = await run(async () => { calls += 1; return response(200, 'not-json'); });
  assert.equal(calls, 1); assert.equal(result.category, 'parse_error'); assert.equal(result.finalHttpStatus, 200);
});

test('retry can recover successfully', async () => {
  let calls = 0; const { result } = await run(async () => ++calls === 1 ? response(502, 'error code: 502') : response(200, JSON.stringify({ data: [{ id: 'ok' }] })));
  assert.equal(result.category, 'success'); assert.equal(result.attempts, 2); assert.equal(result.dataCount, 1);
});

test('401 is not retried', async () => {
  let calls = 0; const { result, sleeps } = await run(async () => { calls += 1; return response(401, '{"error":"unauthorized"}'); });
  assert.equal(calls, 1); assert.equal(result.category, 'http_error'); assert.equal(result.finalHttpStatus, 401); assert.deepEqual(sleeps, []);
});

test('429 honors Retry-After before retrying', async () => {
  let calls = 0; const { result, sleeps } = await run(async () => ++calls === 1 ? response(429, 'slow down', { 'Retry-After': '2' }) : response(200, JSON.stringify({ data: [{ id: 'ok' }] })));
  assert.equal(result.category, 'success'); assert.deepEqual(sleeps, [2000]); assert.equal(result.attempts, 2);
});
