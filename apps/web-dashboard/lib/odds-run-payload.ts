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
