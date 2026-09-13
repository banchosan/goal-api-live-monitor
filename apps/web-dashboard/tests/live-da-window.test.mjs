import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveDangerousAttacksWindow } from '../lib/live-da-window.ts';

function snapshot({ status = '60', minute = 60, home = 42, away = 20, at = `2026-09-13T10:${String(minute).padStart(2, '0')}:00.000Z` } = {}) {
  return { fixture_id:'goal-api:fixture-1', source_client_event_id:`event-${status}-${minute}-${at}`, captured_at:at, elapsed_minute:minute, added_time:null, match_status:status, home_score:0, away_score:0, shots_home:null, shots_away:null, shots_on_target_home:null, shots_on_target_away:null, corners_home:null, corners_away:null, attacks_home:null, attacks_away:null, dangerous_attacks_home:home, dangerous_attacks_away:away, yellow_cards_home:null, yellow_cards_away:null, red_cards_home:null, red_cards_away:null, saves_home:null, saves_away:null, passes_total_home:null, passes_total_away:null, passes_accurate_home:null, passes_accurate_away:null, possession_home:null, possession_away:null };
}

test('uses normal snapshots for HT and the newest causal <=65 checkpoint', () => {
  const window = resolveDangerousAttacksWindow([snapshot({ status:'HT', minute:45, home:38, away:29 }), snapshot({ minute:64, home:53, away:35 }), snapshot({ minute:66, home:60, away:39 })]);
  assert.equal(window?.halfTime?.home, 38);
  assert.equal(window?.cutoff?.actualMinute, 64);
  assert.equal(window?.cutoff?.home, 53);
});

test('does not substitute a stale value for a 65 minute checkpoint', () => {
  const window = resolveDangerousAttacksWindow([snapshot({ status:'HT', minute:45 }), snapshot({ minute:58 })]);
  assert.equal(window?.cutoff, null);
});

test('requires both observed HT DA values while preserving a true zero', () => {
  const validZero = resolveDangerousAttacksWindow([snapshot({ status:'HT', minute:45, home:0, away:0 }), snapshot({ minute:64 })]);
  const missing = resolveDangerousAttacksWindow([snapshot({ status:'HT', minute:45, home:null, away:0 }), snapshot({ minute:64 })]);
  assert.deepEqual(validZero?.halfTime && [validZero.halfTime.home, validZero.halfTime.away], [0, 0]);
  assert.equal(missing?.halfTime, null);
});
