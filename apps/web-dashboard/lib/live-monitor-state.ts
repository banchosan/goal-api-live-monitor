export function withoutFixture<T>(matches: Record<string, T>, fixtureId: string) {
  const next = { ...matches };
  delete next[fixtureId];
  return next;
}

export function visibleCollectorFixtures<T extends { id: string }>(fixtures: T[], hiddenFixtureIds: ReadonlySet<string>) {
  return fixtures.filter((fixture) => !hiddenFixtureIds.has(fixture.id));
}
