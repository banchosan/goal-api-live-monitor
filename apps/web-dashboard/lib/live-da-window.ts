import { resolveCheckpoint, type LiveSnapshot } from './live-delta.ts';

export type DangerousAttacksWindow = {
  fixtureId: string;
  halfTime: { actualMinute: number | null; capturedAt: string | null; home: number | null; away: number | null } | null;
  cutoff: { targetMinute: 65; actualMinute: number | null; capturedAt: string | null; home: number | null; away: number | null } | null;
};

/**
 * Selects the causal HT baseline and the newest observed state at/before 65'.
 * This is deliberately derived from the ordinary live snapshot timeline: no
 * special 60-minute record is created or required.
 */
export function resolveDangerousAttacksWindow(snapshots: LiveSnapshot[], maxLagMinutes = 5): DangerousAttacksWindow | null {
  if (!snapshots.length) return null;
  const halfTime = resolveCheckpoint(snapshots, 'HT', maxLagMinutes);
  const cutoff = resolveCheckpoint(snapshots, 65, maxLagMinutes);
  return {
    fixtureId: snapshots[0].fixture_id,
    // An observed HT status is necessary but not sufficient: both DA values
    // must be present. A real zero remains valid; null never becomes zero.
    halfTime: halfTime.snapshot && halfTime.snapshot.dangerous_attacks_home !== null && halfTime.snapshot.dangerous_attacks_away !== null ? {
      actualMinute: halfTime.actualMinute,
      capturedAt: halfTime.capturedAt,
      home: halfTime.snapshot.dangerous_attacks_home,
      away: halfTime.snapshot.dangerous_attacks_away,
    } : null,
    cutoff: cutoff.snapshot ? {
      targetMinute: 65,
      actualMinute: cutoff.actualMinute,
      capturedAt: cutoff.capturedAt,
      home: cutoff.snapshot.dangerous_attacks_home,
      away: cutoff.snapshot.dangerous_attacks_away,
    } : null,
  };
}
