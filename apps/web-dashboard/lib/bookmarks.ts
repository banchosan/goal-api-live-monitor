export const BOOKMARK_STATUSES = ['waiting', 'monitoring', 'finished', 'removed'] as const;
export type BookmarkStatus = typeof BOOKMARK_STATUSES[number];

export type BookmarkInput = {
  fixtureId: string; home: string; away: string; league: string; country?: string;
  kickoffUtc: string; reason?: string; relatedTeamId?: string | null; relatedTeamName?: string | null;
};

export function normalizeBookmarkInput(value: unknown): BookmarkInput {
  const input = (value ?? {}) as Record<string, unknown>;
  const required = ['fixtureId', 'home', 'away', 'league', 'kickoffUtc'] as const;
  for (const key of required) if (!String(input[key] ?? '').trim()) throw new Error(`${key}が必要です`);
  const kickoffUtc = new Date(String(input.kickoffUtc));
  if (!Number.isFinite(kickoffUtc.getTime())) throw new Error('kickoffUtcが不正です');
  return {
    fixtureId: String(input.fixtureId).trim(), home: String(input.home).trim(), away: String(input.away).trim(),
    league: String(input.league).trim(), country: String(input.country ?? '').trim(), kickoffUtc: kickoffUtc.toISOString(),
    reason: String(input.reason ?? 'manual').trim() || 'manual',
    relatedTeamId: input.relatedTeamId ? String(input.relatedTeamId) : null,
    relatedTeamName: input.relatedTeamName ? String(input.relatedTeamName) : null,
  };
}

export function isBookmarkStatus(value: unknown): value is BookmarkStatus {
  return BOOKMARK_STATUSES.includes(value as BookmarkStatus);
}
