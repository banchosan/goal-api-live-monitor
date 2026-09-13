type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};

/** Reads both legacy array payloads and resumable batched-run payloads. */
export function oddsFixtureLookupResponses(raw: string | null | undefined): unknown[] {
  try {
    const parsed: unknown = JSON.parse(raw || '[]');
    if (Array.isArray(parsed)) return parsed;
    const responses = object(parsed).fixtureResponses;
    return Array.isArray(responses) ? responses : [];
  } catch { return []; }
}
export function fixturesFromOddsRunPayload(raw: string | null | undefined): JsonObject[] {
  return oddsFixtureLookupResponses(raw).flatMap((entry) => {
    const response = object(object(entry).payload).response;
    return Array.isArray(response) ? response.filter((fixture): fixture is JsonObject => fixture !== null && typeof fixture === 'object') : [];
  });
}
export function oddsUnmatched(raw: string | null | undefined): unknown[] {
  try { const parsed: unknown = JSON.parse(raw || '[]'); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}
/** Converts internal GOAL fixture contexts into safe, display-only primitives. */
export function displayOddsUnmatched(raw: string | null | undefined) {
  return oddsUnmatched(raw).map((entry) => {
    const outer = object(entry), source = object(outer.goal && typeof outer.goal === 'object' ? outer.goal : outer);
    const side = (value: unknown) => { const row = object(value); return typeof value === 'string' ? value : typeof row.name === 'string' ? row.name : ''; };
    return { fixtureId: typeof source.id === 'string' ? source.id : typeof outer.goalFixtureId === 'string' ? outer.goalFixtureId : '', home: side(source.home), away: side(source.away), league: typeof source.league === 'string' ? source.league : '', country: typeof source.country === 'string' ? source.country : '' };
  });
}
