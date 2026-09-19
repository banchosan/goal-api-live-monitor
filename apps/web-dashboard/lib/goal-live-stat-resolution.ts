export type GoalLiveStatistic = { type?: unknown; home?: unknown; away?: unknown };

function normalizedType(value: unknown) { return String(value ?? '').trim().toLowerCase(); }

/** Keep absent/malformed provider values absent; do not coerce them to zero. */
export function goalLiveStatNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = String(value ?? '').replace('%', '').trim();
  if (!text) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function pairTotal(stat: GoalLiveStatistic) {
  const home = goalLiveStatNumber(stat.home); const away = goalLiveStatNumber(stat.away);
  return home === null || away === null ? null : home + away;
}

/**
 * GOAL occasionally sends the same statistic more than once in one frame.
 * Raw arrays remain unchanged. This resolver is only for typed/display facts:
 * possession prefers the latest credible 100%-total pair, while cumulative
 * statistics prefer the largest complete pair.
 */
export function resolveGoalLiveStatistic(statistics: GoalLiveStatistic[], names: string[]): GoalLiveStatistic | null {
  const allowed = new Set(names.map(normalizedType));
  const candidates = statistics.filter((stat) => allowed.has(normalizedType(stat?.type)));
  if (!candidates.length) return null;
  const possession = allowed.has('ball possession') || allowed.has('possession');
  if (possession) {
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      const total = pairTotal(candidates[index]);
      if (total !== null && Math.abs(total - 100) <= 1) return candidates[index];
    }
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      if (goalLiveStatNumber(candidates[index].home) !== null || goalLiveStatNumber(candidates[index].away) !== null) return candidates[index];
    }
    return candidates.at(-1) ?? null;
  }
  let selected = candidates[0]; let selectedTotal = pairTotal(selected);
  for (const candidate of candidates.slice(1)) {
    const total = pairTotal(candidate);
    if (total !== null && (selectedTotal === null || total > selectedTotal)) { selected = candidate; selectedTotal = total; }
  }
  return selected;
}

export type GoalLiveDisplayStat = { type: string; home: unknown; away: unknown };

const DISPLAY_GROUPS = [
  { label: 'Corners', primary: ['corners'], fallback: [] },
  { label: 'Attacks', primary: ['attacks'], fallback: [] },
  { label: 'Dangerous Attacks', primary: ['dangerous attacks'], fallback: [] },
  { label: 'On Target', primary: ['on target'], fallback: ['shots on goal', 'shots on target'] },
  { label: 'Off Target', primary: ['off target'], fallback: ['shots off goal'] },
  { label: 'Ball Possession', primary: ['ball possession', 'possession'], fallback: [] },
  { label: 'Yellow Cards', primary: ['yellow cards'], fallback: [] },
  { label: 'Red Cards', primary: ['red cards'], fallback: [] },
  { label: 'Saves', primary: ['saves'], fallback: [] },
  { label: 'Passes Total', primary: ['passes total'], fallback: [] },
  { label: 'Passes Accurate', primary: ['passes accurate'], fallback: [] },
] as const;

/** One readable row per stat concept; raw duplicate/alias evidence is retained elsewhere. */
export function canonicalGoalLiveDisplayStats(statistics: GoalLiveStatistic[]): GoalLiveDisplayStat[] {
  const hidden = new Set<string>(); const rows: GoalLiveDisplayStat[] = [];
  for (const group of DISPLAY_GROUPS) {
    [...group.primary, ...group.fallback].forEach((type) => hidden.add(type));
    const primary = resolveGoalLiveStatistic(statistics, [...group.primary]);
    const selected = primary ?? resolveGoalLiveStatistic(statistics, [...group.fallback]);
    if (selected) rows.push({ type: group.label, home: selected.home, away: selected.away });
  }
  const seen = new Set(rows.map((row) => normalizedType(row.type)));
  for (const stat of statistics) {
    const type = normalizedType(stat?.type);
    if (!type || hidden.has(type) || seen.has(type)) continue;
    const selected = resolveGoalLiveStatistic(statistics, [type]);
    if (!selected) continue;
    seen.add(type); rows.push({ type: String(selected.type ?? '').trim(), home: selected.home, away: selected.away });
  }
  return rows;
}

/** Same concept sent with different numeric pairs: show a warning, never invent a value. */
export function hasGoalLiveStatisticConflict(statistics: GoalLiveStatistic[]): boolean {
  for (const group of DISPLAY_GROUPS) {
    const candidates = statistics.filter((stat) => [...group.primary, ...group.fallback].includes(normalizedType(stat?.type) as never));
    const pairs = new Set(candidates.map((stat) => `${goalLiveStatNumber(stat.home)}:${goalLiveStatNumber(stat.away)}`));
    if (pairs.size > 1) return true;
  }
  return false;
}
