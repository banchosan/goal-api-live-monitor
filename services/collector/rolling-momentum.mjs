/**
 * Shared, provider-safe rolling pressure evaluator.
 *
 * It consumes only observed Socket points at/before the current update.  A
 * missing value stays missing and a cumulative decrease is treated as a data
 * quality anomaly, never as negative pressure.
 */
export const ROLLING_MOMENTUM_RULE_ID = 'rolling_attack_da_pressure';
export const ROLLING_MOMENTUM_RULE_VERSION = 'v2';

const RAPID = { duration: 10, attack: 15, dangerousAttacks: 7, differential: 6 };
const SUSTAINED = { duration: 15, attack: 12, dangerousAttacks: 10, differential: 8 };
const MAX_CHECKPOINT_LAG = 3;

function numberOrNull(value) {
  const parsed = Number(String(value ?? '').replace('%', '').trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function pair(statistics, aliases) {
  const allowed = new Set(aliases.map((alias) => alias.toLowerCase()));
  let selected = null;
  let selectedTotal = -1;
  for (const statistic of statistics ?? []) {
    if (!allowed.has(String(statistic?.type ?? '').trim().toLowerCase())) continue;
    const home = numberOrNull(statistic.home); const away = numberOrNull(statistic.away);
    const total = home === null || away === null ? -1 : home + away;
    if (total > selectedTotal) { selected = { home, away }; selectedTotal = total; }
  }
  return selected ?? { home: null, away: null };
}

/** Converts one already-received GOAL Socket statistic frame to a small point. */
export function rollingMomentumPoint(statistics, minute, capturedAt) {
  const attacks = pair(statistics, ['attacks']);
  const dangerousAttacks = pair(statistics, ['dangerous attacks']);
  const onTarget = pair(statistics, ['on target', 'shots on goal', 'shots on target']);
  const corners = pair(statistics, ['corners']);
  return {
    minute: numberOrNull(minute), capturedAt,
    home: { attacks: attacks.home, dangerousAttacks: dangerousAttacks.home, onTarget: onTarget.home, corners: corners.home },
    away: { attacks: attacks.away, dangerousAttacks: dangerousAttacks.away, onTarget: onTarget.away, corners: corners.away },
  };
}

function ordered(points, phase) {
  return [...points]
    .filter((point) => point.minute !== null && (phase === 'first_half' ? point.minute >= 0 && point.minute <= 45 : point.minute > 45))
    .sort((left, right) => left.minute - right.minute || String(left.capturedAt).localeCompare(String(right.capturedAt)));
}

/** Causal checkpoint: newest point at/before minute, bounded by a real gap. */
function checkpoint(points, targetMinute) {
  const point = points.filter((item) => item.minute <= targetMinute).at(-1) ?? null;
  if (!point || targetMinute - point.minute > MAX_CHECKPOINT_LAG) return null;
  return point;
}

function delta(start, end, side, field) {
  const before = start?.[side]?.[field]; const after = end?.[side]?.[field];
  if (before === null || before === undefined || after === null || after === undefined) return { value: null, anomaly: null };
  if (after < before) return { value: null, anomaly: 'cumulative_decrease' };
  return { value: after - before, anomaly: null };
}

function evaluateWindow(points, current, side, rule) {
  const opponent = side === 'HOME' ? 'AWAY' : 'HOME';
  const own = side.toLowerCase(); const other = opponent.toLowerCase();
  const start = checkpoint(points, current.minute - rule.duration);
  const midpoint = checkpoint(points, current.minute - 5);
  if (!start || !midpoint) return { eligible: false, reason: 'insufficient_socket_history' };
  const attack = delta(start, current, own, 'attacks');
  const opponentAttack = delta(start, current, other, 'attacks');
  const dangerousAttacks = delta(start, current, own, 'dangerousAttacks');
  const opponentDa = delta(start, current, other, 'dangerousAttacks');
  const firstFiveDa = delta(start, midpoint, own, 'dangerousAttacks');
  const lastFiveDa = delta(midpoint, current, own, 'dangerousAttacks');
  const anomalies = [attack, opponentAttack, dangerousAttacks, opponentDa, firstFiveDa, lastFiveDa].map((item) => item.anomaly).filter(Boolean);
  if (anomalies.length) return { eligible: false, reason: 'cumulative_correction', anomalies };
  if ([attack.value, opponentAttack.value, dangerousAttacks.value, opponentDa.value, firstFiveDa.value, lastFiveDa.value].some((value) => value === null)) return { eligible: false, reason: 'statistics_missing' };
  const differential = dangerousAttacks.value - opponentDa.value;
  const activeSegments = [firstFiveDa.value, lastFiveDa.value].filter((value) => value > 0).length;
  const eligible = attack.value >= rule.attack && dangerousAttacks.value >= rule.dangerousAttacks && differential >= rule.differential && activeSegments === 2;
  return {
    eligible, startMinute: start.minute, endMinute: current.minute, attackDelta: attack.value, opponentAttackDelta: opponentAttack.value,
    daDelta: dangerousAttacks.value, opponentDaDelta: opponentDa.value, pressureDiff: differential,
    firstFiveDa: firstFiveDa.value, lastFiveDa: lastFiveDa.value, activeSegments,
    rule: rule === RAPID ? 'rapid_10m' : 'sustained_15m',
  };
}

/**
 * Evaluates both sides at the newest observed point. This is intentionally
 * stateless: caller state owns the first-fire timestamp and UI state changes.
 */
export function evaluateRollingMomentum(points) {
  // Current means the latest received frame, not the largest provider minute.
  // A provider minute rollback therefore cannot make an older future point
  // leak into this evaluation.
  const observed = [...points].filter((point) => point.minute !== null && point.minute >= 0)
    .sort((left, right) => String(left.capturedAt).localeCompare(String(right.capturedAt)));
  const current = observed.at(-1) ?? null;
  const phase = current && current.minute <= 45 ? 'first_half' : 'second_half';
  const history = current ? ordered(observed.filter((point) => String(point.capturedAt) <= String(current.capturedAt)), phase) : [];
  // Start observing from the very first usable Socket frame in each half.
  // A signal still requires a real causal 10/15 minute window below; we never
  // invent a kickoff or half-time baseline merely to fire sooner.
  if (!current) return { phase, currentMinute: null, HOME: { eligible: false, reason: `${phase}_history_waiting` }, AWAY: { eligible: false, reason: `${phase}_history_waiting` } };
  const result = { phase, currentMinute: current.minute };
  for (const side of ['HOME', 'AWAY']) {
    const rapid = evaluateWindow(history, current, side, RAPID);
    const sustained = evaluateWindow(history, current, side, SUSTAINED);
    const selected = rapid.eligible ? rapid : sustained.eligible ? sustained : null;
    const own = side.toLowerCase();
    const recentStart = checkpoint(history, current.minute - 5);
    const recent = recentStart ? delta(recentStart, current, own, 'dangerousAttacks') : { value: null, anomaly: null };
    result[side] = selected
      ? { ...selected, eligible: true, recentFiveDa: recent.value, recentFiveAnomaly: recent.anomaly }
      // Keep the latest valid ten-minute values visible even when a side no
      // longer meets the firing threshold.  That makes cooling/faded states
      // explainable rather than showing a misleading blank panel.
      : { ...rapid, eligible: false, reason: rapid.reason === 'cumulative_correction' || sustained.reason === 'cumulative_correction' ? 'cumulative_correction' : rapid.reason === 'insufficient_socket_history' && sustained.reason === 'insufficient_socket_history' ? 'insufficient_socket_history' : 'threshold_not_met', recentFiveDa: recent.value, recentFiveAnomaly: recent.anomaly };
  }
  return result;
}

export function nextRollingMomentumState(previous, evaluation, capturedAt) {
  const firstFiredAtMinute = previous?.firstFiredAtMinute ?? (evaluation.eligible ? evaluation.endMinute : null);
  const firstFiredAt = previous?.firstFiredAt ?? (evaluation.eligible ? capturedAt : null);
  let state = 'waiting';
  if (evaluation.reason === 'cumulative_correction' || evaluation.recentFiveAnomaly) state = 'quality_check';
  else if (evaluation.eligible) state = 'active';
  else if (firstFiredAtMinute !== null && evaluation.recentFiveDa !== null && evaluation.recentFiveDa <= 1) state = 'faded';
  else if (firstFiredAtMinute !== null) state = 'cooling';
  return { ...evaluation, state, firstFiredAtMinute, firstFiredAt, updatedAt: capturedAt };
}
