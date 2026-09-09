import test from 'node:test';
import assert from 'node:assert/strict';
import { projectLiveSnapshot } from '../lib/live-snapshot.ts';

test('projects nullable typed live statistics while retaining raw statistics separately', () => {
  const snapshot = projectLiveSnapshot({ data: { match_status: '70', match_hometeam_score: '2', match_awayteam_score: '1', statistics: [
    { type: 'Shots Total', home: '11', away: '4' }, { type: 'Corners', home: '6', away: '2' }, { type: 'Ball Possession', home: '60%', away: '40%' },
  ] } });
  assert.equal(snapshot.elapsedMinute, 70);
  assert.equal(snapshot.shotsHome, 11);
  assert.equal(snapshot.possessionAway, 40);
  assert.equal(snapshot.dangerousAttacksHome, null);
  assert.equal(snapshot.rawStatistics.length, 3);
});
