export const TEAM_RESULTS_CONCURRENCY = 3;
export const TEAM_RESULTS_MAX_ATTEMPTS = 3;
export const TEAM_RESULTS_TIMEOUT_MS = 15_000;

const RETRYABLE_HTTP = new Set([429, 502, 503, 504]);
const DEFAULT_BACKOFF_MS = [500, 1_500];
const BODY_PREVIEW_LIMIT = 500;

export type FetchLike = (input: string, init?: RequestInit) => Promise<Pick<Response, 'ok' | 'status' | 'headers' | 'text'>>;
export type AttemptRecord = {
  attempt: number;
  requestStartedAt: string;
  requestCompletedAt: string;
  httpStatus: number | null;
  bodyPreview: string | null;
  error: string | null;
  retryAfter: string | null;
  retryScheduledMs: number | null;
};

export type TeamResultsFetchResult = {
  category: 'success' | 'no_data' | 'http_error' | 'timeout_or_network' | 'parse_error' | 'exhausted_retry';
  failureCategory: 'http_error' | 'timeout_or_network' | null;
  data: Record<string, unknown>[];
  source: unknown;
  attempts: number;
  finalHttpStatus: number | null;
  finalError: string | null;
  requestStartedAt: string;
  requestCompletedAt: string;
  dataCount: number;
  attemptLog: AttemptRecord[];
};

type Options = {
  apiKey: string;
  teamId: string;
  fetchImpl?: FetchLike;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => string;
  timeoutMs?: number;
  maxAttempts?: number;
};

const delay = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

function preview(value: string): string {
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').slice(0, BODY_PREVIEW_LIMIT);
}

function retryAfterMilliseconds(value: string | null, nowMs = Date.now()): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, 30_000);
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return null;
  return Math.min(Math.max(0, date - nowMs), 30_000);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || 'network error');
}

export async function fetchTeamResults(options: Options): Promise<TeamResultsFetchResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? delay;
  const now = options.now ?? (() => new Date().toISOString());
  const timeoutMs = options.timeoutMs ?? TEAM_RESULTS_TIMEOUT_MS;
  const maxAttempts = options.maxAttempts ?? TEAM_RESULTS_MAX_ATTEMPTS;
  const attemptLog: AttemptRecord[] = [];
  const firstStartedAt = now();

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const requestStartedAt = attempt === 1 ? firstStartedAt : now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(
        `https://api.goal-api.com/v1/teams/${encodeURIComponent(options.teamId)}/results?limit=5&offset=0`,
        { headers: { Authorization: `Bearer ${options.apiKey}`, Accept: 'application/json' }, cache: 'no-store', signal: controller.signal },
      );
      const rawText = await response.text();
      const requestCompletedAt = now();
      const bodyPreview = preview(rawText);
      const retryAfter = response.headers.get('retry-after');

      if (!response.ok) {
        const retryable = RETRYABLE_HTTP.has(response.status);
        const canRetry = retryable && attempt < maxAttempts;
        const retryScheduledMs = canRetry
          ? (response.status === 429 ? retryAfterMilliseconds(retryAfter) : null) ?? DEFAULT_BACKOFF_MS[Math.min(attempt - 1, DEFAULT_BACKOFF_MS.length - 1)]
          : null;
        attemptLog.push({ attempt, requestStartedAt, requestCompletedAt, httpStatus: response.status, bodyPreview, error: `HTTP ${response.status}`, retryAfter, retryScheduledMs });
        if (canRetry && retryScheduledMs !== null) { await sleep(retryScheduledMs); continue; }
        return {
          category: retryable && attempt === maxAttempts ? 'exhausted_retry' : 'http_error',
          failureCategory: 'http_error', data: [], source: null, attempts: attempt,
          finalHttpStatus: response.status, finalError: `HTTP ${response.status}: ${bodyPreview || 'empty response body'}`,
          requestStartedAt: firstStartedAt, requestCompletedAt, dataCount: 0, attemptLog,
        };
      }

      let payload: unknown;
      try { payload = JSON.parse(rawText); }
      catch (error) {
        const finalError = `Invalid JSON: ${errorMessage(error)}`;
        attemptLog.push({ attempt, requestStartedAt, requestCompletedAt, httpStatus: response.status, bodyPreview, error: finalError, retryAfter, retryScheduledMs: null });
        return { category: 'parse_error', failureCategory: null, data: [], source: null, attempts: attempt, finalHttpStatus: response.status, finalError, requestStartedAt: firstStartedAt, requestCompletedAt, dataCount: 0, attemptLog };
      }
      const record = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
      const data = Array.isArray(record.data) ? record.data.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object') : [];
      attemptLog.push({ attempt, requestStartedAt, requestCompletedAt, httpStatus: response.status, bodyPreview: null, error: null, retryAfter, retryScheduledMs: null });
      return {
        category: data.length ? 'success' : 'no_data', failureCategory: null, data,
        source: record.source ?? null, attempts: attempt, finalHttpStatus: response.status, finalError: null,
        requestStartedAt: firstStartedAt, requestCompletedAt, dataCount: data.length, attemptLog,
      };
    } catch (error) {
      const requestCompletedAt = now();
      const timedOut = error instanceof Error && error.name === 'AbortError';
      const reason = timedOut ? `timeout after ${timeoutMs}ms` : errorMessage(error);
      const canRetry = attempt < maxAttempts;
      const retryScheduledMs = canRetry ? DEFAULT_BACKOFF_MS[Math.min(attempt - 1, DEFAULT_BACKOFF_MS.length - 1)] : null;
      attemptLog.push({ attempt, requestStartedAt, requestCompletedAt, httpStatus: null, bodyPreview: null, error: reason, retryAfter: null, retryScheduledMs });
      if (canRetry && retryScheduledMs !== null) { await sleep(retryScheduledMs); continue; }
      return {
        category: attempt === maxAttempts ? 'exhausted_retry' : 'timeout_or_network',
        failureCategory: 'timeout_or_network', data: [], source: null, attempts: attempt,
        finalHttpStatus: null, finalError: reason, requestStartedAt: firstStartedAt,
        requestCompletedAt, dataCount: 0, attemptLog,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error('unreachable');
}
