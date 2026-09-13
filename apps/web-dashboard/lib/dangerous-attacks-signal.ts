export const DA_SIGNAL_RULE_ID = 'dangerous_attacks_ht_increase';
export const DA_SIGNAL_RULE_VERSION = 'v1';
export const DA_SIGNAL_THRESHOLD = 15;
export const DA_SIGNAL_DEADLINE_MINUTE = 65;
export const KICKOFF_DA_SIGNAL_RULE_ID = 'dangerous_attacks_kickoff_increase';
export const KICKOFF_DA_SIGNAL_RULE_VERSION = 'v1';
export const KICKOFF_DA_SIGNAL_THRESHOLD = 20;
export const KICKOFF_DA_SIGNAL_DEADLINE_MINUTE = 25;

export type LiveSignalSnapshot = {
  fixtureId: string;
  provider: string;
  providerFixtureId: string | null;
  sourceClientEventId: string;
  providerEventKey: string;
  capturedAt: string;
  elapsedMinute: number | null;
  addedTime: number | null;
  matchStatus: string | null;
  homeScore: number | null;
  awayScore: number | null;
  dangerousAttacksHome: number | null;
  dangerousAttacksAway: number | null;
};

export type DangerousAttacksEvaluation =
  | { kind: 'not_applicable'; reason: string }
  | { kind: 'quality_skip'; reason: string }
  | { kind: 'eligible'; signals: DangerousAttacksSignal[] };

export type DangerousAttacksSignal = {
  side: 'HOME' | 'AWAY';
  signalId: string;
  signalKey: 'HOME' | 'AWAY';
  ruleId: typeof DA_SIGNAL_RULE_ID;
  ruleVersion: typeof DA_SIGNAL_RULE_VERSION;
  detectedAt: string;
  detectedMinute: number;
  addedTime: number | null;
  ruleParameters: Record<string, number>;
  feature: Record<string, unknown>;
};

export type KickoffDangerousAttacksSignal = Omit<DangerousAttacksSignal, 'ruleId' | 'ruleVersion'> & {
  ruleId: typeof KICKOFF_DA_SIGNAL_RULE_ID;
  ruleVersion: typeof KICKOFF_DA_SIGNAL_RULE_VERSION;
};

function finite(value: number | null): value is number { return typeof value === 'number' && Number.isFinite(value); }

export function isHalfTimeSnapshot(snapshot: Pick<LiveSignalSnapshot, 'matchStatus' | 'elapsedMinute'>) {
  const status = String(snapshot.matchStatus ?? '').trim().toUpperCase().replace(/[_-]/g, ' ');
  return ['HT', 'HALF TIME', 'HALF-TIME'].includes(status) || (snapshot.elapsedMinute === 45 && status.includes('HALF'));
}

/**
 * Evaluates one observed state only.  It never substitutes null with zero and
 * requires an HT observation captured at or before this trigger snapshot.
 */
export function evaluateDangerousAttacksHtIncrease(input: {
  baseline: LiveSignalSnapshot | null;
  current: LiveSignalSnapshot;
  identityResolved: boolean;
}): DangerousAttacksEvaluation {
  const { baseline, current, identityResolved } = input;
  if (!identityResolved) return { kind: 'not_applicable', reason: 'fixture_identity_unresolved' };
  if (!baseline) return { kind: 'not_applicable', reason: 'ht_baseline_missing' };
  if (Date.parse(baseline.capturedAt) > Date.parse(current.capturedAt)) return { kind: 'quality_skip', reason: 'future_ht_baseline_rejected' };
  if (!finite(current.elapsedMinute)) return { kind: 'not_applicable', reason: 'minute_missing' };
  if (current.elapsedMinute > DA_SIGNAL_DEADLINE_MINUTE) return { kind: 'not_applicable', reason: 'deadline_passed' };
  if (!finite(baseline.dangerousAttacksHome) || !finite(baseline.dangerousAttacksAway)) return { kind: 'not_applicable', reason: 'ht_dangerous_attacks_missing' };
  if (!finite(current.dangerousAttacksHome) || !finite(current.dangerousAttacksAway)) return { kind: 'not_applicable', reason: 'current_dangerous_attacks_missing' };

  const homeIncrease = current.dangerousAttacksHome - baseline.dangerousAttacksHome;
  const awayIncrease = current.dangerousAttacksAway - baseline.dangerousAttacksAway;
  if (homeIncrease < 0 || awayIncrease < 0) return { kind: 'quality_skip', reason: 'dangerous_attacks_cumulative_decrease' };

  const minutesSinceHt = current.elapsedMinute - 45;
  if (minutesSinceHt <= 0) return { kind: 'not_applicable', reason: 'not_after_half_time' };
  const commonFeature = {
    provider: current.provider,
    providerFixtureId: current.providerFixtureId,
    triggerSnapshotId: current.sourceClientEventId,
    triggerProviderEventKey: current.providerEventKey,
    baselineSnapshotId: baseline.sourceClientEventId,
    baselineProviderEventKey: baseline.providerEventKey,
    htTimestamp: baseline.capturedAt,
    detectedAt: current.capturedAt,
    detectedMinute: current.elapsedMinute,
    addedTime: current.addedTime,
    minutesSinceHt,
    thresholdValue: DA_SIGNAL_THRESHOLD,
    deadlineMinute: DA_SIGNAL_DEADLINE_MINUTE,
    homeScore: current.homeScore,
    awayScore: current.awayScore,
    scoreDifference: finite(current.homeScore) && finite(current.awayScore) ? current.homeScore - current.awayScore : null,
    htHomeDangerousAttacks: baseline.dangerousAttacksHome,
    htAwayDangerousAttacks: baseline.dangerousAttacksAway,
    currentHomeDangerousAttacks: current.dangerousAttacksHome,
    currentAwayDangerousAttacks: current.dangerousAttacksAway,
    homeDaIncrease: homeIncrease,
    awayDaIncrease: awayIncrease,
    homeMinusAwayDaIncrease: homeIncrease - awayIncrease,
    awayMinusHomeDaIncrease: awayIncrease - homeIncrease,
    homeDaIncreasePerMinute: homeIncrease / minutesSinceHt,
    awayDaIncreasePerMinute: awayIncrease / minutesSinceHt,
  };
  const signals = (['HOME', 'AWAY'] as const).flatMap((side) => {
    const increase = side === 'HOME' ? homeIncrease : awayIncrease;
    if (increase < DA_SIGNAL_THRESHOLD) return [];
    return [{
      side,
      signalId: `live:${DA_SIGNAL_RULE_ID}:${DA_SIGNAL_RULE_VERSION}:${current.fixtureId}:${side}`,
      signalKey: side,
      ruleId: DA_SIGNAL_RULE_ID,
      ruleVersion: DA_SIGNAL_RULE_VERSION,
      detectedAt: current.capturedAt,
      detectedMinute: current.elapsedMinute,
      addedTime: current.addedTime,
      ruleParameters: { thresholdValue: DA_SIGNAL_THRESHOLD, deadlineMinute: DA_SIGNAL_DEADLINE_MINUTE },
      feature: { ...commonFeature, signalSide: side },
    } satisfies DangerousAttacksSignal];
  });
  return { kind: 'eligible', signals };
}

/**
 * Evaluates the opening 25 minutes from an actually observed provider minute
 * 0/1 update. It deliberately does not use a later connection-time snapshot
 * as a kickoff baseline.
 */
export function evaluateDangerousAttacksKickoffIncrease(input: {
  baseline: LiveSignalSnapshot | null;
  current: LiveSignalSnapshot;
  identityResolved: boolean;
}): DangerousAttacksEvaluation | { kind: 'eligible'; signals: KickoffDangerousAttacksSignal[] } {
  const { baseline, current, identityResolved } = input;
  if (!identityResolved) return { kind: 'not_applicable', reason: 'fixture_identity_unresolved' };
  if (!baseline) return { kind: 'not_applicable', reason: 'kickoff_baseline_missing' };
  if (Date.parse(baseline.capturedAt) > Date.parse(current.capturedAt)) return { kind: 'quality_skip', reason: 'future_kickoff_baseline_rejected' };
  if (!finite(baseline.elapsedMinute) || baseline.elapsedMinute < 0 || baseline.elapsedMinute > 1) return { kind: 'quality_skip', reason: 'kickoff_baseline_not_observed' };
  if (!finite(current.elapsedMinute)) return { kind: 'not_applicable', reason: 'minute_missing' };
  if (current.elapsedMinute > KICKOFF_DA_SIGNAL_DEADLINE_MINUTE) return { kind: 'not_applicable', reason: 'deadline_passed' };
  if (current.elapsedMinute <= baseline.elapsedMinute) return { kind: 'not_applicable', reason: 'not_after_kickoff' };
  if (!finite(baseline.dangerousAttacksHome) || !finite(baseline.dangerousAttacksAway)) return { kind: 'not_applicable', reason: 'kickoff_dangerous_attacks_missing' };
  if (!finite(current.dangerousAttacksHome) || !finite(current.dangerousAttacksAway)) return { kind: 'not_applicable', reason: 'current_dangerous_attacks_missing' };
  const homeIncrease = current.dangerousAttacksHome - baseline.dangerousAttacksHome;
  const awayIncrease = current.dangerousAttacksAway - baseline.dangerousAttacksAway;
  if (homeIncrease < 0 || awayIncrease < 0) return { kind: 'quality_skip', reason: 'dangerous_attacks_cumulative_decrease' };
  const minutesSinceKickoff = current.elapsedMinute - baseline.elapsedMinute;
  const feature = {
    provider: current.provider, providerFixtureId: current.providerFixtureId,
    triggerSnapshotId: current.sourceClientEventId, triggerProviderEventKey: current.providerEventKey,
    baselineSnapshotId: baseline.sourceClientEventId, baselineProviderEventKey: baseline.providerEventKey,
    kickoffTimestamp: baseline.capturedAt, kickoffMinute: baseline.elapsedMinute,
    detectedAt: current.capturedAt, detectedMinute: current.elapsedMinute, addedTime: current.addedTime,
    minutesSinceKickoff, thresholdValue: KICKOFF_DA_SIGNAL_THRESHOLD, deadlineMinute: KICKOFF_DA_SIGNAL_DEADLINE_MINUTE,
    homeScore: current.homeScore, awayScore: current.awayScore,
    scoreDifference: finite(current.homeScore) && finite(current.awayScore) ? current.homeScore - current.awayScore : null,
    kickoffHomeDangerousAttacks: baseline.dangerousAttacksHome, kickoffAwayDangerousAttacks: baseline.dangerousAttacksAway,
    currentHomeDangerousAttacks: current.dangerousAttacksHome, currentAwayDangerousAttacks: current.dangerousAttacksAway,
    homeDaIncrease: homeIncrease, awayDaIncrease: awayIncrease,
    homeMinusAwayDaIncrease: homeIncrease - awayIncrease, awayMinusHomeDaIncrease: awayIncrease - homeIncrease,
    homeDaIncreasePerMinute: homeIncrease / minutesSinceKickoff, awayDaIncreasePerMinute: awayIncrease / minutesSinceKickoff,
  };
  const signals = (['HOME', 'AWAY'] as const).flatMap((side) => {
    const increase = side === 'HOME' ? homeIncrease : awayIncrease;
    if (increase < KICKOFF_DA_SIGNAL_THRESHOLD) return [];
    return [{ side, signalId: `live:${KICKOFF_DA_SIGNAL_RULE_ID}:${KICKOFF_DA_SIGNAL_RULE_VERSION}:${current.fixtureId}:${side}`,
      signalKey: side, ruleId: KICKOFF_DA_SIGNAL_RULE_ID, ruleVersion: KICKOFF_DA_SIGNAL_RULE_VERSION,
      detectedAt: current.capturedAt, detectedMinute: current.elapsedMinute, addedTime: current.addedTime,
      ruleParameters: { thresholdValue: KICKOFF_DA_SIGNAL_THRESHOLD, deadlineMinute: KICKOFF_DA_SIGNAL_DEADLINE_MINUTE },
      feature: { ...feature, signalSide: side },
    } satisfies KickoffDangerousAttacksSignal];
  });
  return { kind: 'eligible', signals };
}
