#!/usr/bin/env node
/** Read-only report for arbitrary causal LIVE snapshot delta windows. */
import { DatabaseSync } from 'node:sqlite';
import { calculateLiveDelta, inspectLiveSnapshotQuality, type LiveSnapshot } from '../apps/web-dashboard/lib/live-delta.ts';

const [dbPath, ...fixtureIds] = process.argv.slice(2);
if (!dbPath || !fixtureIds.length) throw new Error('usage: live_delta_report.ts <local.sqlite> <provider-fixture-id> [...]');
const db = new DatabaseSync(dbPath, { readOnly: true });
const coreIds = fixtureIds.map((id) => `goal-api:${id}`);
const rows = db.prepare(`SELECT * FROM live_snapshots WHERE fixture_id IN (${coreIds.map(() => '?').join(',')}) ORDER BY fixture_id,captured_at,id`).all(...coreIds) as LiveSnapshot[];
const windows: [number, number][] = [[50, 60], [60, 70], [70, 75], [75, 80]];
const report = Object.fromEntries(coreIds.map((fixtureId) => {
  const snapshots = rows.filter((row) => row.fixture_id === fixtureId);
  return [fixtureId.replace('goal-api:', ''), {
    snapshots: snapshots.length,
    windows: Object.fromEntries(windows.map(([start, end]) => [`${start}->${end}`, calculateLiveDelta(snapshots, start, end)])),
    quality: inspectLiveSnapshotQuality(snapshots),
  }];
}));
console.log(JSON.stringify(report, null, 2));
db.close();
