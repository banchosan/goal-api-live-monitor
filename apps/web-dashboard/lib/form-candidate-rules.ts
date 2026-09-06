export type FormResultCode = 'W' | 'D' | 'L';

export type FormResult = {
  result: FormResultCode;
  score?: string;
  opponent?: string;
  fixtureId?: string;
};

export type RecentFormExclusionCode = 'LL' | 'DL' | 'LD';

/** GOAL API recent-results payload is newest-first; UI/rules use oldest-first. */
export function toChronologicalResults<T>(newestFirst: T[]) {
  return [...newestFirst].reverse();
}

export function isBaseFormCandidate(played: number, wins: number, draws: number) {
  return played === 5 && (wins >= 4 || (wins === 3 && draws >= 1));
}

/**
 * Results must be chronological (oldest -> newest). The final two entries are
 * therefore the two most recent completed matches.
 */
export function recentFormExclusion(results: FormResult[]) {
  const recentTwo = results.slice(-2).map((item) => item.result);
  if (recentTwo.length < 2) {
    return { excluded: false, code: null, reason: null, recentTwo } as const;
  }

  const code = recentTwo.join('') as RecentFormExclusionCode;
  if (code === 'LL' || code === 'DL' || code === 'LD') {
    return {
      excluded: true,
      code,
      reason: `直近2試合が${code}のため除外`,
      recentTwo,
    } as const;
  }
  return { excluded: false, code: null, reason: null, recentTwo } as const;
}

export function evaluateFormCandidate(input: {
  results: FormResult[];
  played: number;
  wins: number;
  draws: number;
}) {
  const baseQualified = isBaseFormCandidate(input.played, input.wins, input.draws);
  const recent = recentFormExclusion(input.results);
  return {
    baseQualified,
    qualified: baseQualified && !recent.excluded,
    recentTwo: recent.recentTwo,
    recentTwoExcluded: recent.excluded,
    exclusionCode: recent.code,
    exclusionReason: recent.reason,
  };
}
