type FixtureId = { id: string };
type CandidateFixture = { fixtureId: string };
type BookmarkFixture = { fixtureId: string };

/** Form candidates are team-side rows; reduce them to unique fixture IDs before bulk actions. */
export function formQualifiedFixtureIds(candidates: readonly CandidateFixture[]) {
  return new Set(candidates.map((candidate) => String(candidate.fixtureId)).filter(Boolean));
}

/** Bulk Bookmark is deliberately narrower than manual Bookmark: only qualified form fixtures qualify. */
export function qualifiedUnbookmarkedFixtures<T extends FixtureId>(fixtures: readonly T[], candidates: readonly CandidateFixture[], bookmarks: readonly BookmarkFixture[]) {
  const qualified = formQualifiedFixtureIds(candidates);
  const bookmarked = new Set(bookmarks.map((bookmark) => String(bookmark.fixtureId)));
  return fixtures.filter((fixture) => qualified.has(String(fixture.id)) && !bookmarked.has(String(fixture.id)));
}
