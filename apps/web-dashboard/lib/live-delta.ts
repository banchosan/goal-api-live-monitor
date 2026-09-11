export type LiveSnapshot = {
  id?: number;
  fixture_id: string;
  source_client_event_id: string;
  provider_event_key?: string | null;
  captured_at: string;
  elapsed_minute: number | null;
  added_time?: number | null;
  match_status?: string | null;
  home_score: number | null; away_score: number | null;
  shots_home: number | null; shots_away: number | null;
  shots_on_target_home: number | null; shots_on_target_away: number | null;
  corners_home: number | null; corners_away: number | null;
  attacks_home: number | null; attacks_away: number | null;
  dangerous_attacks_home: number | null; dangerous_attacks_away: number | null;
  yellow_cards_home: number | null; yellow_cards_away: number | null;
  red_cards_home: number | null; red_cards_away: number | null;
  saves_home: number | null; saves_away: number | null;
  passes_total_home: number | null; passes_total_away: number | null;
  passes_accurate_home: number | null; passes_accurate_away: number | null;
  possession_home: number | null; possession_away: number | null;
};

export type CheckpointTarget = number | 'HT';
export type Checkpoint = {
  targetMinute: CheckpointTarget;
  actualMinute: number | null;
  capturedAt: string | null;
  differenceMinutes: number | null;
  status: string | null;
  snapshot: LiveSnapshot | null;
  insufficient: boolean;
  reason?: 'no_snapshot_at_or_before_target' | 'outside_tolerance' | 'no_half_time_status';
};

export type StatDelta = { start: number | null; end: number | null; delta: number | null; anomaly: 'cumulative_decrease' | null };
export type PossessionDelta = { start: number | null; end: number | null; change: number | null };
export type TeamDelta = {
  score: StatDelta; shots: StatDelta; shotsOnTarget: StatDelta; corners: StatDelta; attacks: StatDelta;
  dangerousAttacks: StatDelta; yellowCards: StatDelta; redCards: StatDelta; saves: StatDelta;
  passesTotal: StatDelta; passesAccurate: StatDelta; possession: PossessionDelta;
};
export type LiveDelta = {
  start: Checkpoint; end: Checkpoint; sufficient: boolean;
  home: TeamDelta | null; away: TeamDelta | null;
  pressure: Record<'shots' | 'shotsOnTarget' | 'corners' | 'attacks' | 'dangerousAttacks', number | null> | null;
  anomalies: { field: string; side: 'home' | 'away'; kind: 'cumulative_decrease' }[];
};

const cumulative: [keyof TeamDelta, keyof LiveSnapshot, keyof LiveSnapshot][] = [
  ['score', 'home_score', 'away_score'], ['shots', 'shots_home', 'shots_away'],
  ['shotsOnTarget', 'shots_on_target_home', 'shots_on_target_away'], ['corners', 'corners_home', 'corners_away'],
  ['attacks', 'attacks_home', 'attacks_away'], ['dangerousAttacks', 'dangerous_attacks_home', 'dangerous_attacks_away'],
  ['yellowCards', 'yellow_cards_home', 'yellow_cards_away'], ['redCards', 'red_cards_home', 'red_cards_away'],
  ['saves', 'saves_home', 'saves_away'], ['passesTotal', 'passes_total_home', 'passes_total_away'],
  ['passesAccurate', 'passes_accurate_home', 'passes_accurate_away'],
];

function finite(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
function compare(a: LiveSnapshot, b: LiveSnapshot) {
  return (a.elapsed_minute ?? -1) - (b.elapsed_minute ?? -1) || a.captured_at.localeCompare(b.captured_at) || a.source_client_event_id.localeCompare(b.source_client_event_id);
}
function isHalfTime(snapshot: LiveSnapshot) { return ['HT', 'HALF_TIME', 'HALF TIME'].includes(String(snapshot.match_status ?? '').trim().toUpperCase()); }

/** Sorts copies only. Raw snapshots are never changed or discarded. */
export function orderedSnapshots(snapshots: LiveSnapshot[]) { return [...snapshots].sort(compare); }

/**
 * Default resolver is causal: it picks the newest observation at/before the
 * requested minute. It will never use a later snapshot as a past checkpoint.
 */
export function resolveCheckpoint(snapshots: LiveSnapshot[], targetMinute: CheckpointTarget, maxLagMinutes = 5): Checkpoint {
  const ordered = orderedSnapshots(snapshots);
  if (targetMinute === 'HT') {
    const snapshot = ordered.filter(isHalfTime).at(-1) ?? null;
    return snapshot ? { targetMinute, actualMinute: snapshot.elapsed_minute, capturedAt: snapshot.captured_at, differenceMinutes: null, status: snapshot.match_status ?? null, snapshot, insufficient: false }
      : { targetMinute, actualMinute: null, capturedAt: null, differenceMinutes: null, status: null, snapshot: null, insufficient: true, reason: 'no_half_time_status' };
  }
  const snapshot = ordered.filter((item) => item.elapsed_minute !== null && item.elapsed_minute <= targetMinute).at(-1) ?? null;
  if (!snapshot || snapshot.elapsed_minute === null) return { targetMinute, actualMinute: null, capturedAt: null, differenceMinutes: null, status: null, snapshot: null, insufficient: true, reason: 'no_snapshot_at_or_before_target' };
  const differenceMinutes = targetMinute - snapshot.elapsed_minute;
  if (differenceMinutes > maxLagMinutes) return { targetMinute, actualMinute: snapshot.elapsed_minute, capturedAt: snapshot.captured_at, differenceMinutes, status: snapshot.match_status ?? null, snapshot: null, insufficient: true, reason: 'outside_tolerance' };
  return { targetMinute, actualMinute: snapshot.elapsed_minute, capturedAt: snapshot.captured_at, differenceMinutes, status: snapshot.match_status ?? null, snapshot, insufficient: false };
}

function delta(start: number | null, end: number | null): StatDelta {
  if (start === null || end === null) return { start, end, delta: null, anomaly: null };
  if (end < start) return { start, end, delta: null, anomaly: 'cumulative_decrease' };
  return { start, end, delta: end - start, anomaly: null };
}
function possession(start: number | null, end: number | null): PossessionDelta { return { start, end, change: start === null || end === null ? null : end - start }; }
function sideDelta(start: LiveSnapshot, end: LiveSnapshot, side: 'home' | 'away'): TeamDelta {
  const result = {} as Record<string, StatDelta | PossessionDelta>;
  for (const [name, home, away] of cumulative) result[name] = delta(finite(start[side === 'home' ? home : away]), finite(end[side === 'home' ? home : away]));
  result.possession = possession(finite(start[side === 'home' ? 'possession_home' : 'possession_away']), finite(end[side === 'home' ? 'possession_home' : 'possession_away']));
  return result as TeamDelta;
}

export function calculateLiveDelta(snapshots: LiveSnapshot[], startTarget: CheckpointTarget, endTarget: CheckpointTarget, options: { maxLagMinutes?: number } = {}): LiveDelta {
  const maxLagMinutes = options.maxLagMinutes ?? 5;
  const start = resolveCheckpoint(snapshots, startTarget, maxLagMinutes); const end = resolveCheckpoint(snapshots, endTarget, maxLagMinutes);
  if (!start.snapshot || !end.snapshot) return { start, end, sufficient: false, home: null, away: null, pressure: null, anomalies: [] };
  const home = sideDelta(start.snapshot, end.snapshot, 'home'); const away = sideDelta(start.snapshot, end.snapshot, 'away');
  const anomalies = (['home', 'away'] as const).flatMap((side) => cumulative.flatMap(([field]) => {
    const item = (side === 'home' ? home : away)[field] as StatDelta;
    return item.anomaly ? [{ field: String(field), side, kind: item.anomaly }] : [];
  }));
  const pressure = Object.fromEntries(['shots', 'shotsOnTarget', 'corners', 'attacks', 'dangerousAttacks'].map((field) => {
    const homeDelta = (home[field as keyof TeamDelta] as StatDelta).delta; const awayDelta = (away[field as keyof TeamDelta] as StatDelta).delta;
    return [field, homeDelta === null || awayDelta === null ? null : homeDelta - awayDelta];
  })) as LiveDelta['pressure'];
  return { start, end, sufficient: true, home, away, pressure, anomalies };
}

export function inspectLiveSnapshotQuality(snapshots: LiveSnapshot[]) {
  const ordered = orderedSnapshots(snapshots); const byTime = [...snapshots].sort((a, b) => a.captured_at.localeCompare(b.captured_at) || a.source_client_event_id.localeCompare(b.source_client_event_id));
  let minuteRegressions = 0; let outOfOrderInput = 0;
  for (let index = 1; index < snapshots.length; index += 1) if (snapshots[index].captured_at < snapshots[index - 1].captured_at) outOfOrderInput += 1;
  for (let index = 1; index < byTime.length; index += 1) {
    const previous = byTime[index - 1].elapsed_minute; const current = byTime[index].elapsed_minute;
    if (previous !== null && current !== null && current < previous) minuteRegressions += 1;
  }
  const duplicateKeys = new Set<string>(); let duplicates = 0;
  for (const item of ordered) { const key = item.provider_event_key || item.source_client_event_id; if (duplicateKeys.has(key)) duplicates += 1; duplicateKeys.add(key); }
  const cumulativeDecreases = byTime.slice(1).flatMap((item, index) => (['home', 'away'] as const).flatMap((side) => cumulative.flatMap(([field, home, away]) => {
    const before = finite(byTime[index][side === 'home' ? home : away]); const after = finite(item[side === 'home' ? home : away]);
    return before !== null && after !== null && after < before ? [{ field: String(field), side, kind: 'cumulative_decrease' as const }] : [];
  })));
  const intervals = byTime.slice(1).map((item, index) => Date.parse(item.captured_at) - Date.parse(byTime[index].captured_at)).filter(Number.isFinite);
  return { snapshots: ordered.length, duplicates, outOfOrderInput, minuteRegressions, cumulativeDecreases, intervalSeconds: intervals.map((ms) => ms / 1000) };
}
