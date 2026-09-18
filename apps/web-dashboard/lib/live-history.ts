import { orderedSnapshots, resolveCheckpoint, type CheckpointTarget, type LiveSnapshot } from './live-delta.ts';
import { normalizeGoalLiveSnapshot } from './goal-live-normalizer.ts';

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

export type RawGoalMonitorEvent = {
  id: number;
  fixtureId: string;
  receivedAt: string;
  payload: unknown;
  clientEventId?: string | null;
  providerTimestamp?: string | null;
  payloadHash?: string | null;
};

/**
 * Makes a display-only snapshot for a historical raw event.  It never writes
 * or invents a core identity; displayFixtureId is deliberately a local key.
 */
export function snapshotFromRawGoalMonitorEvent(event: RawGoalMonitorEvent, displayFixtureId: string): LiveSnapshot | null {
  const normalized = normalizeGoalLiveSnapshot({ fixtureId: event.fixtureId, receivedAt: event.receivedAt, payload: event.payload,
    clientEventId: event.clientEventId ?? `raw-monitor-event:${event.id}`, providerTimestamp: event.providerTimestamp,
    payloadHash: event.payloadHash }, displayFixtureId);
  if (!normalized) return null;
  return {
    fixture_id: displayFixtureId, source_client_event_id: normalized.sourceClientEventId, provider_event_key: normalized.providerEventKey,
    captured_at: normalized.capturedAt, elapsed_minute: normalized.elapsedMinute, added_time: normalized.addedTime,
    match_status: normalized.matchStatus, home_score: normalized.homeScore, away_score: normalized.awayScore,
    shots_home: normalized.shotsHome, shots_away: normalized.shotsAway, shots_on_target_home: normalized.shotsOnTargetHome,
    shots_on_target_away: normalized.shotsOnTargetAway, corners_home: normalized.cornersHome, corners_away: normalized.cornersAway,
    attacks_home: normalized.attacksHome, attacks_away: normalized.attacksAway,
    dangerous_attacks_home: normalized.dangerousAttacksHome, dangerous_attacks_away: normalized.dangerousAttacksAway,
    possession_home: normalized.possessionHome, possession_away: normalized.possessionAway,
    yellow_cards_home: normalized.yellowCardsHome, yellow_cards_away: normalized.yellowCardsAway,
    red_cards_home: normalized.redCardsHome, red_cards_away: normalized.redCardsAway,
    saves_home: normalized.savesHome, saves_away: normalized.savesAway,
    passes_total_home: normalized.passesTotalHome, passes_total_away: normalized.passesTotalAway,
    passes_accurate_home: normalized.passesAccurateHome, passes_accurate_away: normalized.passesAccurateAway,
  };
}

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
  const timeOrdered = [...ordered].sort((a, b) => a.captured_at.localeCompare(b.captured_at) || String(a.source_client_event_id).localeCompare(String(b.source_client_event_id)));
  // Terminal provider frames often have elapsed_minute=NULL.  Display status
  // and final score must therefore follow capture time, not the highest minute.
  const latest = timeOrdered.at(-1) ?? null;
  const maxGapSeconds = timeOrdered.slice(1).reduce((maximum, snapshot, index) => {
    const gap = (Date.parse(snapshot.captured_at) - Date.parse(timeOrdered[index].captured_at)) / 1000;
    return Number.isFinite(gap) ? Math.max(maximum, gap) : maximum;
  }, 0);
  const checkpoints = ([25, 'HT', 55, 60, 65] as CheckpointTarget[]).map((target) => checkpointView(ordered, target));
  const first = timeOrdered.find((snapshot) => numberOrNull(snapshot.elapsed_minute) !== null) ?? null;
  const last = [...timeOrdered].reverse().find((snapshot) => numberOrNull(snapshot.elapsed_minute) !== null) ?? null;
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
