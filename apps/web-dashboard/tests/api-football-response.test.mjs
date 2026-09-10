import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiFootballResponseError, parseApiFootballResponse, publicApiFootballFailure } from '../lib/api-football-response.ts';
import { readJsonResponse, responseFailureMessage } from '../lib/safe-json-response.ts';

async function failure(response, endpoint = '/odds') {
  try {
    await parseApiFootballResponse(response, endpoint);
    assert.fail('expected API-Football response failure');
  } catch (error) {
    assert.ok(error instanceof ApiFootballResponseError);
    return error.detail;
  }
}

test('429 with an empty body is a structured HTTP failure, not a JSON parse crash', async () => {
  const detail = await failure(new Response('', { status: 429, headers: { 'content-type': 'text/plain' } }));
  assert.equal(detail.kind, 'http_error');
  assert.equal(detail.status, 429);
  assert.equal(detail.bodyPreview, '<empty>');
  assert.equal(publicApiFootballFailure(detail).endpoint, '/odds');
});

test('503 plain text and 500 JSON body retain endpoint, status and safe body preview', async () => {
  const unavailable = await failure(new Response('temporarily unavailable', { status: 503, headers: { 'content-type': 'text/plain' } }));
  assert.equal(unavailable.bodyPreview, 'temporarily unavailable');
  const server = await failure(new Response('{"message":"upstream failed"}', { status: 500, headers: { 'content-type': 'application/json' } }));
  assert.equal(server.status, 500);
  assert.match(server.bodyPreview, /upstream failed/);
});

test('200 invalid JSON and empty body are explicit parse diagnostics', async () => {
  const invalid = await failure(new Response('not-json', { status: 200, headers: { 'content-type': 'text/plain' } }), '/fixtures');
  assert.equal(invalid.kind, 'invalid_json');
  const empty = await failure(new Response('', { status: 200, headers: { 'content-type': 'application/json' } }), '/fixtures');
  assert.equal(empty.kind, 'empty_body');
});

test('200 valid JSON passes through unchanged', async () => {
  assert.deepEqual(await parseApiFootballResponse(new Response('{"response":[{"fixture":{"id":1}}]}', { status: 200, headers: { 'content-type': 'application/json' } }), '/fixtures'), { response: [{ fixture: { id: 1 } }] });
});

test('frontend-safe parser reports empty and non-JSON route responses without throwing', async () => {
  const empty = await readJsonResponse(new Response('', { status: 500 }));
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.match(responseFailureMessage(empty, 'route'), /body=<empty>/);
  const nonJson = await readJsonResponse(new Response('<html>bad gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } }));
  assert.equal(nonJson.ok, false);
  if (!nonJson.ok) assert.match(responseFailureMessage(nonJson, 'route'), /status=502/);
});
