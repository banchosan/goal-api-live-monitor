import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLiveAnalysisDataset } from '../lib/live-analysis-dataset.ts';

const metadata = { coreFixtureId: 'f1', providerFixtureId: 'goal-f1', kickoffUtc: '2026-09-17T10:00:00Z', homeTeam: 'Home', awayTeam: 'Away' };
const snap = (minute, values = {}) => ({ fixture_id: 'f1', source_client_event_id: `e-${minute}-${values.suffix ?? ''}`, provider_event_key: `k-${minute}-${values.suffix ?? ''}`, captured_at: `2026-09-17T10:${String(minute).padStart(2, '0')}:00Z`, elapsed_minute: minute, match_status: String(minute), home_score: 0, away_score: 0, shots_home: 0, shots_away: 0, shots_on_target_home: 0, shots_on_target_away: 0, corners_home: 0, corners_away: 0, attacks_home: 0, attacks_away: 0, dangerous_attacks_home: 0, dangerous_attacks_away: 0, yellow_cards_home: 0, yellow_cards_away: 0, red_cards_home: 0, red_cards_away: 0, saves_home: 0, saves_away: 0, passes_total_home: 0, passes_total_away: 0, passes_accurate_home: 0, passes_accurate_away: 0, possession_home: 50, possession_away: 50, ...values });
const dataset = (snapshots) => buildLiveAnalysisDataset([{ metadata, snapshots }]);

test('dataset uses actual HT and causal checkpoints only', () => {
  const result = dataset([snap(45, { match_status: '45' }), snap(45, { suffix: 'ht', match_status: 'HT', dangerous_attacks_home: 10 }), snap(59, { dangerous_attacks_home: 14 }), snap(61, { dangerous_attacks_home: 99 }), snap(65, { dangerous_attacks_home: 18 })]);
  const row = result.rows.find((item) => item.side === 'HOME' && item.checkpoint === 60); assert.equal(row.checkpoint_actual_minute, 59); assert.equal(row.ht_da, 10); assert.equal(row.da_delta, 4);
});
test('minute 45 without an actual HT marker is rejected', () => { const result = dataset([snap(45), snap(55)]); assert.equal(result.rows.length, 0); assert.equal(result.skips[0].reason, 'missing_actual_ht'); });
test('NULL and cumulative corrections remain unknown rather than zero or negative activity', () => {
  const result = dataset([snap(45, { match_status: 'HT', dangerous_attacks_home: 10, shots_home: 8 }), snap(55, { dangerous_attacks_home: null, shots_home: 6 }), snap(60), snap(65), snap(70)]);
  const row = result.rows.find((item) => item.side === 'HOME' && item.checkpoint === 55); assert.equal(row.da_delta, null); assert.equal(row.shots_delta, null); assert.match(row.anomaly_flags, /shots/);
});
test('goal labels retain home-away orientation and strict checkpoint boundaries', () => {
  const result = dataset([snap(45, { match_status: 'HT' }), snap(55), snap(60, { home_score: 1, away_score: 0 }), snap(65, { home_score: 1, away_score: 1 }), snap(70, { home_score: 2, away_score: 1 }), snap(75, { home_score: 2, away_score: 1 }), snap(80)]);
  const home = result.rows.find((item) => item.side === 'HOME' && item.checkpoint === 60); const away = result.rows.find((item) => item.side === 'AWAY' && item.checkpoint === 60);
  assert.equal(home.goal_against_next_5m, 1); assert.equal(home.goal_for_next_10m, 1); assert.equal(away.goal_for_next_5m, 1); assert.equal(away.goal_against_next_10m, 1);
  assert.equal(home.score_for, 1); assert.equal(away.score_for, 0);
});
test('missing score makes labels unknown', () => { const result = dataset([snap(45, { match_status: 'HT' }), snap(55), snap(60, { home_score: null }), snap(65), snap(70), snap(75), snap(80)]); const row = result.rows.find((item) => item.side === 'HOME' && item.checkpoint === 60); assert.equal(row.goal_for_next_5m, null); });
