export const LIVE_FIXTURE_STATUSES = ['LIVE', 'HALF_TIME'] as const;

type Pagination = {
  total?: number;
  limit?: number;
  offset?: number;
  hasMore?: boolean;
};

type GoalApiPage = {
  data?: unknown[];
  response?: unknown[];
  pagination?: Pagination;
};

type FetchLike = (input: string, init?: RequestInit) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>;

export type LiveFixturePage = {
  status: string;
  offset: number;
  count: number;
  total: number | null;
  hasMore: boolean | null;
};

const PAGE_LIMIT = 100;
const MAX_PAGES_PER_STATUS = 20;

function rowsFrom(payload: GoalApiPage): unknown[] {
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.response)) return payload.response;
  return [];
}

export async function fetchAllLiveFixtures(
  apiKey: string,
  fetchImpl: FetchLike = fetch,
): Promise<{ fixtures: Record<string, unknown>[]; apiCalls: number; pages: LiveFixturePage[] }> {
  const fixtures: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  const pages: LiveFixturePage[] = [];
  let apiCalls = 0;

  for (const status of LIVE_FIXTURE_STATUSES) {
    let offset = 0;
    for (let pageNumber = 0; pageNumber < MAX_PAGES_PER_STATUS; pageNumber += 1) {
      const url = new URL('https://api.goal-api.com/v1/fixtures');
      url.searchParams.set('status', status);
      url.searchParams.set('limit', String(PAGE_LIMIT));
      url.searchParams.set('offset', String(offset));

      const response = await fetchImpl(url.toString(), {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
        cache: 'no-store',
      });
      apiCalls += 1;
      let payload: GoalApiPage;
      try {
        payload = await response.json() as GoalApiPage;
      } catch {
        throw new Error(`GOAL API invalid JSON (status=${status}, offset=${offset})`);
      }
      if (!response.ok) throw new Error(`GOAL API HTTP ${response.status} (status=${status}, offset=${offset})`);

      const raw = rowsFrom(payload);
      const pagination = payload.pagination;
      pages.push({
        status,
        offset,
        count: raw.length,
        total: Number.isFinite(pagination?.total) ? Number(pagination?.total) : null,
        hasMore: typeof pagination?.hasMore === 'boolean' ? pagination.hasMore : null,
      });

      for (const value of raw) {
        if (!value || typeof value !== 'object') continue;
        const fixture = value as Record<string, unknown>;
        const idValue = fixture.id ?? fixture.fixture_id ?? fixture.fixtureId;
        if (idValue === null || idValue === undefined || idValue === '') continue;
        const id = String(idValue);
        if (seen.has(id)) continue;
        seen.add(id);
        fixtures.push(fixture);
      }

      const hasMore = typeof pagination?.hasMore === 'boolean'
        ? pagination.hasMore
        : raw.length === PAGE_LIMIT;
      if (!hasMore) break;

      const serverOffset = Number.isFinite(pagination?.offset) ? Number(pagination?.offset) : offset;
      const serverLimit = Number.isFinite(pagination?.limit) && Number(pagination?.limit) > 0
        ? Number(pagination?.limit)
        : PAGE_LIMIT;
      const nextOffset = serverOffset + serverLimit;
      if (nextOffset <= offset) throw new Error(`GOAL API pagination did not advance (status=${status}, offset=${offset})`);
      offset = nextOffset;
    }
  }

  return { fixtures, apiCalls, pages };
}
