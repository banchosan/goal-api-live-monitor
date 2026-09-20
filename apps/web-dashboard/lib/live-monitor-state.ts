export function withoutFixture<T>(matches: Record<string, T>, fixtureId: string) {
  const next = { ...matches };
  delete next[fixtureId];
  return next;
}

export function visibleCollectorFixtures<T extends { id: string }>(fixtures: T[], hiddenFixtureIds: ReadonlySet<string>) {
  return fixtures.filter((fixture) => !hiddenFixtureIds.has(fixture.id));
}

/** Keeps the LIVE-card bulk selection separate from the picker selection. */
export function toggleLiveFixtureSelection(selectedFixtureIds: readonly string[], fixtureId: string) {
  return selectedFixtureIds.includes(fixtureId)
    ? selectedFixtureIds.filter((id) => id !== fixtureId)
    : [...selectedFixtureIds, fixtureId];
}

export function toggleAllLiveFixtureSelections(selectedFixtureIds: readonly string[], visibleFixtureIds: readonly string[]) {
  const visibleIds = [...new Set(visibleFixtureIds)];
  const selectedVisibleIds = selectedFixtureIds.filter((id) => visibleIds.includes(id));
  return visibleIds.length > 0 && selectedVisibleIds.length === visibleIds.length ? [] : visibleIds;
}
