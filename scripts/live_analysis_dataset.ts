#!/usr/bin/env node
/** Read-only LIVE analysis dataset exporter. Writes only CSV/JSON artifacts outside D1. */
import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';
import { buildLiveAnalysisDataset, daBucket, type FixtureMetadata, type LiveAnalysisRow } from '../apps/web-dashboard/lib/live-analysis-dataset.ts';
import type { LiveSnapshot } from '../apps/web-dashboard/lib/live-delta.ts';

const args = process.argv.slice(2); const dbPath = args[0];
if (!dbPath) throw new Error('usage: live_analysis_dataset.ts <local.sqlite> [--from ISO] [--to ISO] [--csv /tmp/file.csv] [--summary /tmp/file.json]');
const option = (name: string, fallback?: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] ?? fallback : fallback; };
const from = option('--from', '1970-01-01T00:00:00.000Z')!; const to = option('--to', '9999-12-31T23:59:59.999Z')!;
const csvPath = option('--csv', '/tmp/live-analysis-dataset.csv')!; const summaryPath = option('--summary', '/tmp/live-analysis-dataset-summary.json')!;
const db = new DatabaseSync(dbPath, { readOnly: true });

type MetadataRow = FixtureMetadata & { coreFixtureId: string };
const scope = db.prepare(`SELECT DISTINCT fixture_id FROM live_snapshots WHERE captured_at >= ? AND captured_at < ?`).all(from, to) as { fixture_id: string }[];
const ids = scope.map((row) => row.fixture_id);
const placeholders = ids.map(() => '?').join(',');
const metadataRows = ids.length ? db.prepare(`SELECT f.id AS coreFixtureId,fp.external_fixture_id AS providerFixtureId,f.kickoff_utc AS kickoffUtc,f.home_name AS homeTeam,f.away_name AS awayTeam
  FROM core_fixtures f LEFT JOIN fixture_provider_ids fp ON fp.fixture_id=f.id AND fp.provider='goal-api' WHERE f.id IN (${placeholders})`).all(...ids) as MetadataRow[] : [];
const snapshotRows = ids.length ? db.prepare(`SELECT * FROM live_snapshots WHERE fixture_id IN (${placeholders}) ORDER BY fixture_id,captured_at,id`).all(...ids) as LiveSnapshot[] : [];
const snapshotsByFixture = new Map<string, LiveSnapshot[]>(); for (const row of snapshotRows) snapshotsByFixture.set(row.fixture_id, [...(snapshotsByFixture.get(row.fixture_id) ?? []), row]);
const fixtures = metadataRows.map((metadata) => ({ metadata, snapshots: snapshotsByFixture.get(metadata.coreFixtureId) ?? [] }));
const result = buildLiveAnalysisDataset(fixtures);

function csv(value: unknown) { if (value === null || value === undefined) return ''; const text = String(value); return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text; }
const columns = Object.keys(result.rows[0] ?? {}) as (keyof LiveAnalysisRow)[];
writeFileSync(csvPath, `${columns.join(',')}\n${result.rows.map((row) => columns.map((column) => csv(row[column])).join(',')).join('\n')}\n`, 'utf8');

type Bucket = { n: number; label5: number; known5: number; label10: number; known10: number; label15: number; known15: number };
const buckets = new Map<string, Bucket>();
for (const row of result.rows) { const bucket = daBucket(row.da_delta); if (!bucket) continue; const key = `${row.checkpoint}|${bucket}`; const item = buckets.get(key) ?? { n: 0, label5: 0, known5: 0, label10: 0, known10: 0, label15: 0, known15: 0 }; item.n += 1;
  for (const [label, count, known] of [['goal_for_next_5m', 'label5', 'known5'], ['goal_for_next_10m', 'label10', 'known10'], ['goal_for_next_15m', 'label15', 'known15']] as const) { const value = row[label]; if (value !== null) { item[known] += 1; item[count] += value; } } buckets.set(key, item); }
const bucketSummary = [...buckets.entries()].map(([key, item]) => { const [checkpoint, bucket] = key.split('|'); const rate = (goal: number, known: number) => known ? goal / known : null; return { checkpoint: Number(checkpoint), bucket, n: item.n, goal_for_next_5m: item.label5, rate_5m: rate(item.label5, item.known5), goal_for_next_10m: item.label10, rate_10m: rate(item.label10, item.known10), goal_for_next_15m: item.label15, rate_15m: rate(item.label15, item.known15) }; }).sort((a, b) => a.checkpoint - b.checkpoint || a.bucket.localeCompare(b.bucket));
const signal = result.rows.filter((row) => row.da_delta !== null && row.da_delta >= 15);
const control = result.rows.filter((row) => row.da_delta !== null && row.da_delta < 15);
const aggregate = (rows: LiveAnalysisRow[]) => ({ rows: rows.length, uniqueFixtures: new Set(rows.map((row) => row.core_fixture_id)).size, goalFor5: rows.filter((row) => row.goal_for_next_5m === 1).length, known5: rows.filter((row) => row.goal_for_next_5m !== null).length, goalFor10: rows.filter((row) => row.goal_for_next_10m === 1).length, known10: rows.filter((row) => row.goal_for_next_10m !== null).length, goalFor15: rows.filter((row) => row.goal_for_next_15m === 1).length, known15: rows.filter((row) => row.goal_for_next_15m !== null).length });
const nullFeatures = Object.fromEntries(['ht_da','checkpoint_da','da_delta','shots_delta','sot_delta','corners_delta','attacks_delta','possession_change','score_for','score_against'].map((field) => [field, result.rows.filter((row) => row[field as keyof LiveAnalysisRow] === null).length]));
const summary = { mode: 'read-only', from, to, fixturesProcessed: fixtures.length, rowsGenerated: result.rows.length, expectedRows: fixtures.length * 6, htMissing: result.skips.filter((item) => item.reason === 'missing_actual_ht').length, checkpointMissing: result.skips.filter((item) => item.reason === 'missing_causal_checkpoint').length, skips: result.skips, nullFeatures, anomalyRows: result.rows.filter((row) => row.anomaly_flags !== null).length, labels: { goalFor5Known: result.rows.filter((row) => row.goal_for_next_5m !== null).length, goalFor10Known: result.rows.filter((row) => row.goal_for_next_10m !== null).length, goalFor15Known: result.rows.filter((row) => row.goal_for_next_15m !== null).length }, homeRows: result.rows.filter((row) => row.side === 'HOME').length, awayRows: result.rows.filter((row) => row.side === 'AWAY').length, daBuckets: bucketSummary, da15OrMore: aggregate(signal), daUnder15Control: aggregate(control), csvPath };
writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8'); console.log(JSON.stringify({ ...summary, summaryPath }, null, 2)); db.close();
