import { env } from 'cloudflare:workers';
import { ensureMonitorSchema } from '@/db/monitor';

export const dynamic = 'force-dynamic';

type EventRow = { fixtureId: string; receivedAt: string; payloadJson: string; status: string | null; homeScore: string | null; awayScore: string | null };
type SnapshotRow = { fixtureId: string; capturedAt: string; elapsedMinute: number | null; matchStatus: string | null; homeScore: number | null; awayScore: number | null; rawStatisticsJson: string };
type Stat = { type: string; home: string | number | null; away: string | number | null };

function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' ? value as Record<string, unknown> : {}; }
function parse(value: string) { try { return record(JSON.parse(value)); } catch { return {}; } }
function text(value: unknown, fallback = '') { const result = String(value ?? '').trim(); return result || fallback; }
function minute(data: Record<string, unknown>, status: string) {
  const fromClock = Number(record(data.clock).elapsed); if (Number.isFinite(fromClock)) return fromClock;
  const match = /^(\d+)/.exec(status); return match ? Number(match[1]) : null;
}
function stats(data: Record<string, unknown>): Stat[] { return Array.isArray(data.statistics) ? data.statistics.flatMap((item) => {
  const row = record(item); const type = text(row.type); return type ? [{ type, home: row.home === undefined ? null : String(row.home), away: row.away === undefined ? null : String(row.away) }] : [];
}) : []; }
function savedStats(value: string): Stat[] { try { return Array.isArray(JSON.parse(value)) ? JSON.parse(value).flatMap((item) => {
  const row = record(item); const type = text(row.type); return type ? [{ type, home: row.home === undefined ? null : String(row.home), away: row.away === undefined ? null : String(row.away) }] : [];
}) : []; } catch { return []; } }
function isHt(status: string) { return ['HT', 'HALF_TIME', 'HALF TIME', 'HALF-TIME'].includes(status.toUpperCase()); }

/**
 * Presentation-only fallback for a stale/restarted Collector card. It reads
 * persisted monitor events and never changes Bookmark, identity, or signals.
 */
export async function GET(request: Request) {
  const ids = [...new Set((new URL(request.url).searchParams.get('fixtureIds') ?? '').split(',').map((id) => id.trim()).filter(Boolean))].slice(0, 25);
  if (!ids.length) return Response.json({ fixtures: {} }, { headers: { 'Cache-Control': 'no-store' } });
  const db = (env as unknown as { DB: D1Database }).DB; await ensureMonitorSchema(db);
  const placeholders = ids.map(() => '?').join(',');
  const rows = (await db.prepare(`SELECT fixture_id AS fixtureId,received_at AS receivedAt,payload_json AS payloadJson,status,home_score AS homeScore,away_score AS awayScore
    FROM monitor_events WHERE event_type='match_update' AND fixture_id IN (${placeholders}) ORDER BY fixture_id,received_at,id`).bind(...ids).all<EventRow>()).results ?? [];
  const grouped = new Map<string, EventRow[]>(); for (const row of rows) grouped.set(row.fixtureId, [...(grouped.get(row.fixtureId) ?? []), row]);
  const snapshotRows = (await db.prepare(`SELECT provider_fixture_id AS fixtureId,captured_at AS capturedAt,elapsed_minute AS elapsedMinute,
    match_status AS matchStatus,home_score AS homeScore,away_score AS awayScore,raw_statistics_json AS rawStatisticsJson
    FROM live_snapshots WHERE provider_fixture_id IN (${placeholders}) ORDER BY provider_fixture_id,captured_at,id`).bind(...ids).all<SnapshotRow>()).results ?? [];
  const snapshotsByFixture = new Map<string, SnapshotRow[]>(); for (const row of snapshotRows) snapshotsByFixture.set(row.fixtureId, [...(snapshotsByFixture.get(row.fixtureId) ?? []), row]);
  const fixtures: Record<string, unknown> = {};
  for (const fixtureId of new Set([...grouped.keys(), ...snapshotsByFixture.keys()])) {
    const snapshotHistory = snapshotsByFixture.get(fixtureId) ?? [];
    // Typed snapshots retain normalized full statistics even when a terminal
    // provider frame is sparse. Prefer them for presentation, with raw events
    // below retained as the identity-unresolved fallback.
    if (snapshotHistory.length) {
      const latest = snapshotHistory.at(-1)!;
      let ht: SnapshotRow | null = null; let ko: SnapshotRow | null = null; let cutoff65: SnapshotRow | null = null; let checkpoint65: SnapshotRow | null = null; let checkpoint70: SnapshotRow | null = null; let checkpoint75: SnapshotRow | null = null; let checkpoint80: SnapshotRow | null = null;
      for (const snapshot of snapshotHistory) {
        const value = savedStats(snapshot.rawStatisticsJson); const minute = snapshot.elapsedMinute;
        if (isHt(text(snapshot.matchStatus)) && value.length) ht = snapshot;
        if (minute !== null && minute >= 0 && minute <= 25 && value.length) ko = snapshot;
        if (ht && minute !== null && minute > 45 && minute <= 65 && value.length) cutoff65 = snapshot;
        if (minute !== null && minute > 45 && minute <= 65 && value.length) checkpoint65 = snapshot;
        if (minute !== null && minute > 45 && minute <= 70 && value.length) checkpoint70 = snapshot;
        if (minute !== null && minute > 45 && minute <= 75 && value.length) checkpoint75 = snapshot;
        if (minute !== null && minute > 45 && minute <= 80 && value.length) checkpoint80 = snapshot;
      }
      fixtures[fixtureId] = {
        status: text(latest.matchStatus, 'SAVED'), stats: savedStats(latest.rawStatisticsJson), updatedAt: latest.capturedAt, lastReceivedAt: latest.capturedAt,
        homeScore: latest.homeScore === null ? '-' : String(latest.homeScore), awayScore: latest.awayScore === null ? '-' : String(latest.awayScore),
        updates: snapshotHistory.length, ended: ['FT', 'FINISHED', 'AFTER_ET', 'AFTER_PEN', 'CANCELLED', 'ABANDONED', 'AWARDED'].includes(text(latest.matchStatus).toUpperCase()),
        htStats: ht ? savedStats(ht.rawStatisticsJson) : null, daCutoffStats: cutoff65 ? savedStats(cutoff65.rawStatisticsJson) : null, daCutoffMinute: cutoff65?.elapsedMinute ?? null,
        koCutoffStats: ko ? savedStats(ko.rawStatisticsJson) : null, koCutoffMinute: ko?.elapsedMinute ?? null,
        minute65Stats: checkpoint65 ? savedStats(checkpoint65.rawStatisticsJson) : null, minute65: checkpoint65?.elapsedMinute ?? null,
        minute70Stats: checkpoint70 ? savedStats(checkpoint70.rawStatisticsJson) : null, minute70: checkpoint70?.elapsedMinute ?? null,
        minute75Stats: checkpoint75 ? savedStats(checkpoint75.rawStatisticsJson) : null, minute75: checkpoint75?.elapsedMinute ?? null,
        minute80Stats: checkpoint80 ? savedStats(checkpoint80.rawStatisticsJson) : null, minute80: checkpoint80?.elapsedMinute ?? null, historyFallback: true,
      };
      continue;
    }
    const events = grouped.get(fixtureId) ?? [];
    let latest: { data: Record<string, unknown>; status: string; receivedAt: string } | null = null;
    let ht: { value: Stat[]; minute: number | null } | null = null;
    let ko: { value: Stat[]; minute: number } | null = null;
    let cutoff65: { value: Stat[]; minute: number } | null = null;
    let checkpoint65: { value: Stat[]; minute: number } | null = null;
    let checkpoint70: { value: Stat[]; minute: number } | null = null;
    let checkpoint75: { value: Stat[]; minute: number } | null = null;
    let checkpoint80: { value: Stat[]; minute: number } | null = null;
    for (const event of events) {
      const payload = parse(event.payloadJson); const data = record(payload.data ?? payload);
      const status = text(data.match_status, text(event.status)); const eventStats = stats(data); const at = minute(data, status);
      latest = { data, status, receivedAt: event.receivedAt };
      if (isHt(status) && eventStats.length) ht = { value: eventStats, minute: at };
      if (at !== null && at >= 0 && at <= 25 && eventStats.length) ko = { value: eventStats, minute: at };
      if (ht && at !== null && at > 45 && at <= 65 && eventStats.length) cutoff65 = { value: eventStats, minute: at };
      if (at !== null && at > 45 && at <= 65 && eventStats.length) checkpoint65 = { value: eventStats, minute: at };
      if (at !== null && at > 45 && at <= 70 && eventStats.length) checkpoint70 = { value: eventStats, minute: at };
      if (at !== null && at > 45 && at <= 75 && eventStats.length) checkpoint75 = { value: eventStats, minute: at };
      if (at !== null && at > 45 && at <= 80 && eventStats.length) checkpoint80 = { value: eventStats, minute: at };
    }
    if (!latest) continue;
    fixtures[fixtureId] = {
      status: latest.status || 'SAVED', stats: stats(latest.data), updatedAt: latest.receivedAt, lastReceivedAt: latest.receivedAt,
      homeScore: text(latest.data.match_hometeam_score, '-'), awayScore: text(latest.data.match_awayteam_score, '-'),
      updates: events.length, ended: ['FT', 'FINISHED', 'AFTER_ET', 'AFTER_PEN', 'CANCELLED', 'ABANDONED', 'AWARDED'].includes(latest.status.toUpperCase()),
      htStats: ht?.value ?? null, daCutoffStats: cutoff65?.value ?? null, daCutoffMinute: cutoff65?.minute ?? null,
      koCutoffStats: ko?.value ?? null, koCutoffMinute: ko?.minute ?? null,
      minute65Stats: checkpoint65?.value ?? null, minute65: checkpoint65?.minute ?? null,
      minute70Stats: checkpoint70?.value ?? null, minute70: checkpoint70?.minute ?? null,
      minute75Stats: checkpoint75?.value ?? null, minute75: checkpoint75?.minute ?? null,
      minute80Stats: checkpoint80?.value ?? null, minute80: checkpoint80?.minute ?? null,
      historyFallback: true,
    };
  }
  return Response.json({ fixtures }, { headers: { 'Cache-Control': 'no-store' } });
}
