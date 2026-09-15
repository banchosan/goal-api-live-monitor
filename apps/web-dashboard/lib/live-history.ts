import { orderedSnapshots, resolveCheckpoint, type CheckpointTarget, type LiveSnapshot } from './live-delta.ts';

const TERMINAL_STATUSES = new Set(['FT', 'FINISHED', 'AFTER_ET', 'AFTER_PEN', 'CANCELLED', 'ABANDONED', 'AWARDED']);

export type LiveHistorySignal = {
  id: string;
  ruleId: string;
  ruleVersion: string;
  signalSide: string | null;
  triggeredAt: string;
  detectedMinute: number | null;
  ruleParameters: Record<string, unknown> | null;
  feature: Record<string, unknown> | null;
};

export type LiveHistoryFixture = {
  fixtureId: string;
  providerFixtureId: string | null;
  home: string;
  away: string;
  kickoffUtc: string | null;
};

function terminal(status: string | null | undefined) {
  return TERMINAL_STATUSES.has(String(status ?? '').trim().toUpperCase());
}

function numberOrNull(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function checkpointView(snapshots: LiveSnapshot[], target: CheckpointTarget) {
  const checkpoint = resolveCheckpoint(snapshots, target);
  const snapshot = checkpoint.snapshot;
  return {
    target,
    actualMinute: checkpoint.actualMinute,
    capturedAt: checkpoint.capturedAt,
    status: checkpoint.status,
    insufficient: checkpoint.insufficient,
    reason: checkpoint.reason ?? null,
    homeScore: snapshot?.home_score ?? null,
    awayScore: snapshot?.away_score ?? null,
    dangerousAttacksHome: snapshot?.dangerous_attacks_home ?? null,
    dangerousAttacksAway: snapshot?.dangerous_attacks_away ?? null,
    attacksHome: snapshot?.attacks_home ?? null,
    attacksAway: snapshot?.attacks_away ?? null,
    shotsHome: snapshot?.shots_home ?? null,
    shotsAway: snapshot?.shots_away ?? null,
    shotsOnTargetHome: snapshot?.shots_on_target_home ?? null,
    shotsOnTargetAway: snapshot?.shots_on_target_away ?? null,
    cornersHome: snapshot?.corners_home ?? null,
    cornersAway: snapshot?.corners_away ?? null,
    possessionHome: snapshot?.possession_home ?? null,
    possessionAway: snapshot?.possession_away ?? null,
  };
}

/** Builds a read-only fixture detail from persisted snapshots; it never fills missing values with zero. */
export function buildLiveHistoryDetail(fixture: LiveHistoryFixture, snapshots: LiveSnapshot[], signals: LiveHistorySignal[]) {
  const ordered = orderedSnapshots(snapshots);
  const latest = ordered.at(-1) ?? null;
  const timeOrdered = [...ordered].sort((a, b) => a.captured_at.localeCompare(b.captured_at) || String(a.source_client_event_id).localeCompare(String(b.source_client_event_id)));
  const maxGapSeconds = timeOrdered.slice(1).reduce((maximum, snapshot, index) => {
    const gap = (Date.parse(snapshot.captured_at) - Date.parse(timeOrdered[index].captured_at)) / 1000;
    return Number.isFinite(gap) ? Math.max(maximum, gap) : maximum;
  }, 0);
  const checkpoints = ([25, 'HT', 55, 60, 65] as CheckpointTarget[]).map((target) => checkpointView(ordered, target));
  const first = ordered.find((snapshot) => numberOrNull(snapshot.elapsed_minute) !== null) ?? null;
  const last = [...ordered].reverse().find((snapshot) => numberOrNull(snapshot.elapsed_minute) !== null) ?? null;
  return {
    fixture,
    status: terminal(latest?.match_status) ? 'finished' : 'incomplete',
    latest: latest ? {
      capturedAt: latest.captured_at, status: latest.match_status ?? null, elapsedMinute: latest.elapsed_minute,
      homeScore: latest.home_score, awayScore: latest.away_score,
    } : null,
    snapshotCount: ordered.length,
    firstSnapshotMinute: first?.elapsed_minute ?? null,
    lastSnapshotMinute: last?.elapsed_minute ?? null,
    actualHtObserved: checkpoints.find((checkpoint) => checkpoint.target === 'HT')?.insufficient === false,
    maxGapSeconds: ordered.length > 1 ? maxGapSeconds : null,
    checkpoints,
    signals,
  };
}

export function historyStatus(status: string | null | undefined) { return terminal(status) ? 'finished' : 'incomplete'; }
