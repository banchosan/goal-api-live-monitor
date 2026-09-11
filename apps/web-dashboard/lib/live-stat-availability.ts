type StatValue = string | number | null | undefined;

// Attacks are cumulative football statistics.  Once a match is underway, a
// 0–0 pair is not a meaningful observation; GOAL sometimes sends it as a
// placeholder where this coverage is unavailable.  Keep the raw payload, but
// do not present or analyse this placeholder as a real zero.
const PLACEHOLDER_ZERO_TYPES = new Set(['attacks', 'dangerous attacks']);
const MINUTE_WHERE_ZERO_PAIR_IS_UNAVAILABLE = 15;

function numberOrNull(value: StatValue): number | null {
  const text = String(value ?? '').replace('%', '').trim();
  if (!text) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function elapsedMinute(status: string | number | null | undefined): number | null {
  const match = /^(\d+)(?:\s*\+\s*\d+)?$/.exec(String(status ?? '').trim());
  return match ? Number(match[1]) : null;
}

/**
 * Detects the documented GOAL feed placeholder without changing raw events.
 * This deliberately requires both sides to be zero after minute 15, so a
 * genuine zero for one team (or early match data) remains a numeric value.
 */
export function isGoalProviderPlaceholderZeroPair(type: unknown, home: StatValue, away: StatValue, status: string | number | null | undefined): boolean {
  const minute = elapsedMinute(status);
  if (minute === null || minute < MINUTE_WHERE_ZERO_PAIR_IS_UNAVAILABLE) return false;
  if (!PLACEHOLDER_ZERO_TYPES.has(String(type ?? '').trim().toLowerCase())) return false;
  return numberOrNull(home) === 0 && numberOrNull(away) === 0;
}
