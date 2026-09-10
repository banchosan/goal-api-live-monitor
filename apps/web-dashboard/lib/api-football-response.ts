import { readJsonResponse } from './safe-json-response.ts';

export type ApiFootballFailure = {
  stage: 'api-football-fixtures' | 'api-football-odds';
  endpoint: string;
  status: number;
  contentType: string;
  bodyPreview: string;
  bodyEmpty: boolean;
  kind: 'http_error' | 'invalid_json' | 'empty_body' | 'network_error';
  error: string;
};

export class ApiFootballResponseError extends Error {
  readonly detail: ApiFootballFailure;
  constructor(detail: ApiFootballFailure) { super(`${detail.stage}: ${detail.error}`); this.name = 'ApiFootballResponseError'; this.detail = detail; }
}

export function apiFootballFailure(error: unknown, endpoint: string): ApiFootballFailure {
  if (error instanceof ApiFootballResponseError) return error.detail;
  return { stage: endpoint === '/odds' ? 'api-football-odds' : 'api-football-fixtures', endpoint, status: 0, contentType: '', bodyPreview: '<network error>', bodyEmpty: true, kind: 'network_error', error: error instanceof Error ? error.message : 'network error' };
}

/** Parses only successful JSON API-Football responses, preserving safe diagnostics on every failure. */
export async function parseApiFootballResponse(response: Response, endpoint: string): Promise<Record<string, unknown>> {
  const parsed = await readJsonResponse<Record<string, unknown>>(response);
  if (parsed.ok) return parsed.data;
  const kind = !response.ok ? 'http_error' : parsed.bodyEmpty ? 'empty_body' : 'invalid_json';
  const detail: ApiFootballFailure = {
    stage: endpoint === '/odds' ? 'api-football-odds' : 'api-football-fixtures', endpoint,
    status: parsed.status, contentType: parsed.contentType, bodyPreview: parsed.bodyPreview,
    bodyEmpty: parsed.bodyEmpty, kind, error: !response.ok ? `API-Football HTTP ${parsed.status}` : `API-Football ${kind === 'empty_body' ? 'empty response' : 'invalid JSON'}`,
  };
  throw new ApiFootballResponseError(detail);
}

export function publicApiFootballFailure(failure: ApiFootballFailure) {
  return { ok: false, error: failure.error, stage: failure.stage, endpoint: failure.endpoint, status: failure.status || null, contentType: failure.contentType || null, bodyPreview: failure.bodyPreview, bodyEmpty: failure.bodyEmpty, kind: failure.kind };
}
