type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord {
  return value !== null && typeof value === 'object' ? value as UnknownRecord : {};
}

export function fixtureDetails(response: unknown): UnknownRecord[] {
  return Array.isArray(response) ? response.filter((item): item is UnknownRecord => item !== null && typeof item === 'object') : [];
}

/** Supports the legacy date-grouped shape as well as the new ID-batched shape. */
export function resultFixtureRecords(raw: unknown): UnknownRecord[] {
  if (Array.isArray(raw)) return raw.flatMap((batch) => fixtureDetails(record(batch).response));
  const snapshot = record(raw);
  if (Array.isArray(snapshot.batches)) return snapshot.batches.flatMap((batch) => fixtureDetails(record(batch).response));
  if (Array.isArray(snapshot.responses)) return snapshot.responses.flatMap((batch) => fixtureDetails(record(batch).response));
  return fixtureDetails(snapshot.response);
}

export function detailForAnalysis(fixture: UnknownRecord): UnknownRecord {
  const fixtureData = record(fixture.fixture);
  const score = record(fixture.score);
  return {
    apiFixtureId: fixtureData.id ?? null,
    status: record(fixtureData.status),
    finalResult: { home: record(fixture.goals).home ?? null, away: record(fixture.goals).away ?? null },
    firstHalfResult: record(score.halftime),
    fullTimeResult: record(score.fulltime),
    extraTimeResult: record(score.extratime),
    penaltyResult: record(score.penalty),
    statistics: Array.isArray(fixture.statistics) ? fixture.statistics : null,
    events: Array.isArray(fixture.events) ? fixture.events : null,
    lineups: Array.isArray(fixture.lineups) ? fixture.lineups : null,
    players: Array.isArray(fixture.players) ? fixture.players : null,
  };
}

export function analysisDownloadFilename(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).reduce<Record<string, string>>((values, part) => {
    if (part.type !== 'literal') values[part.type] = part.value;
    return values;
  }, {});
  return `football-analysis_${parts.year}-${parts.month}-${parts.day}_${parts.hour}-${parts.minute}-${parts.second}_JST.json`;
}
