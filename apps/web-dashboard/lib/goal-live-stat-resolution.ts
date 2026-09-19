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
