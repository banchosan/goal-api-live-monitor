/** Provider-independent scheduling only. Network calls remain in the route. */
export const ODDS_BATCH_SIZE = 40;
export function uniqueByFixtureId<T extends { fixtureId?: unknown }>(items: T[]) {
  const seen = new Set<string>();
  return items.filter((item) => { const id = String(item.fixtureId ?? ''); if (!id || seen.has(id)) return false; seen.add(id); return true; });
}
export function splitOddsBatch<T>(items: T[], size = ODDS_BATCH_SIZE) {
  return { batch: items.slice(0, size), remaining: items.slice(size) };
}
/** Keeps durable raw successes out of a retry, then schedules one server batch. */
export function planOddsResume<T>(items: T[], completed: ReadonlySet<string>, id: (item: T) => string, size = ODDS_BATCH_SIZE) {
  const pending = items.filter((item) => !completed.has(id(item)));
  return { pending, ...splitOddsBatch(pending, size) };
}
