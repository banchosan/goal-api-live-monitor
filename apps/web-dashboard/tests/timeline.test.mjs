import test from 'node:test';
import assert from 'node:assert/strict';
import { reconstructAtMinute } from '../lib/timeline.ts';

const event = (eventType, minute, receivedAt, extra = {}) => ({
  sessionId: 'session-1', fixtureId: 'fixture-1', eventType, receivedAt,
  source: 'websocket', payload: minute === null ? {} : { data: { match_status: String(minute), statistics: [{ type: 'Shots Total', home: String(minute), away: '1' }] } },
  ...extra,
});

test('uses the nearest observation at or before the requested minute', () => {
  const result = reconstructAtMinute([
    event('session_start', null, '2026-09-05T10:00:00.000Z'),
    event('match_update', 59, '2026-09-05T10:59:00.000Z'),
    event('match_update', 62, '2026-09-05T11:02:00.000Z'),
  ], 'fixture-1', 60);
  assert.equal(result.actualObservedMinute, 59);
  assert.equal(result.freshnessMinutes, 1);
  assert.equal(result.missing, false);
});

test('marks a requested minute inside a recorded disconnect as missing', () => {
  const result = reconstructAtMinute([
    event('session_start', null, '2026-09-05T10:00:00.000Z'),
    event('match_update', 59, '2026-09-05T10:59:00.000Z'),
    event('socket_disconnect', null, '2026-09-05T10:59:10.000Z'),
    event('reconnect_scheduled', null, '2026-09-05T10:59:11.000Z'),
    event('auth_success', null, '2026-09-05T11:04:00.000Z'),
    event('match_update', 65, '2026-09-05T11:05:00.000Z'),
  ], 'fixture-1', 60);
  assert.equal(result.connectionGap, true);
  assert.equal(result.missing, true);
});

test('does not invent a state outside a monitoring session', () => {
  const result = reconstructAtMinute([], 'fixture-1', 30);
  assert.equal(result.monitoringSession, false);
  assert.equal(result.actualObservedMinute, null);
  assert.equal(result.missing, true);
});
