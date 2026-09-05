export const dynamic = 'force-dynamic';

const API_BASE = 'https://api.goal-api.com/v1';
const PAGE_SIZE = 100;
const MAX_PAGES_PER_DATE = 10;
type RawFixture = Record<string, any>;

function utcDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function kickoffValue(fixture: RawFixture) {
  const direct = fixture.kickoffUtc ?? fixture.kickoff_utc;
  if (typeof direct === 'string' && direct) return direct;

  const date = fixture.matchDate ?? fixture.match_date;
  const time = fixture.matchTime ?? fixture.match_time;
  if (typeof date === 'string' && typeof time === 'string') return `${date}T${time}:00.000Z`;
  return null;
}

function fixtureId(fixture: RawFixture) {
  const id = fixture.id ?? fixture.fixture_id ?? fixture.fixtureId;
  return id === null || id === undefined ? null : String(id);
}

export async function GET() {
  const apiKey = process.env.GOAL_API_KEY;
  if (!apiKey) return Response.json({ error: 'GOAL_API_KEYが未設定です', apiRequests: 0 }, { status: 500 });

  const startedAt = new Date();
  const endsAt = new Date(startedAt.getTime() + 24 * 60 * 60 * 1000);
  const rawFixtures: RawFixture[] = [];
  let apiRequests = 0;
  let truncated = false;

  try {
    // The generic /fixtures endpoint is ordered from the far end of the date
    // range and can require many pages before reaching "now". Fetch the two
    // UTC calendar dates directly, then apply the exact rolling 24h window.
    const dates = [...new Set([utcDate(startedAt), utcDate(endsAt)])];
    for (const date of dates) {
      let offset = 0;
      const seenPages = new Set<string>();
      for (let page = 0; page < MAX_PAGES_PER_DATE; page += 1) {
        const query = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
        const response = await fetch(`${API_BASE}/fixtures/date/${encodeURIComponent(date)}?${query}`, {
          headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
          cache: 'no-store',
        });
        apiRequests += 1;
        const payload = await response.json();
        if (!response.ok) {
          const detail = payload?.details ? JSON.stringify(payload.details) : payload?.message ?? payload?.error ?? payload?.code;
          return Response.json({ error: `GOAL API HTTP ${response.status}${detail ? `: ${String(detail)}` : ''}`, apiRequests }, { status: response.status });
        }

        const pageFixtures = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.response) ? payload.response : [];
        const signature = pageFixtures.map(fixtureId).filter(Boolean).join('|');
        if (signature && seenPages.has(signature)) { truncated = true; break; }
        if (signature) seenPages.add(signature);
        rawFixtures.push(...pageFixtures);
        if (pageFixtures.length === 0 || !payload?.pagination?.hasMore) break;
        offset += pageFixtures.length;
        if (page === MAX_PAGES_PER_DATE - 1) truncated = true;
      }
    }

    const startMs = startedAt.getTime();
    const endMs = endsAt.getTime();
    let missingId = 0;
    let invalidKickoff = 0;
    let outsideWindow = 0;
    const uniqueRawFixtures = [...new Map(rawFixtures.map((fixture) => [fixtureId(fixture), fixture])).values()];
    const fixtures = uniqueRawFixtures.flatMap((fixture) => {
      const kickoffUtc = kickoffValue(fixture);
      const kickoffMs = kickoffUtc ? Date.parse(kickoffUtc) : Number.NaN;
      const id = fixtureId(fixture);
      if (!id) { missingId += 1; return []; }
      if (!Number.isFinite(kickoffMs)) { invalidKickoff += 1; return []; }
      if (kickoffMs < startMs || kickoffMs > endMs) { outsideWindow += 1; return []; }
      return [{
        id: String(id),
        league: fixture.leagueName ?? fixture.league?.name ?? fixture.league_name ?? 'Unknown league',
        country: fixture.countryName ?? fixture.league?.country?.name ?? fixture.country_name ?? '',
        home: fixture.homeTeamName ?? fixture.homeTeam?.name ?? fixture.match_hometeam_name ?? 'Home',
        away: fixture.awayTeamName ?? fixture.awayTeam?.name ?? fixture.match_awayteam_name ?? 'Away',
        homeTeamId: String(fixture.homeTeamId ?? fixture.homeTeam?.id ?? fixture.match_hometeam_id ?? ''),
        awayTeamId: String(fixture.awayTeamId ?? fixture.awayTeam?.id ?? fixture.match_awayteam_id ?? ''),
        kickoffUtc,
        kickoffJst: new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(kickoffMs)),
        status: String(fixture.matchStatus ?? fixture.match_status ?? fixture.status ?? 'SCHEDULED'),
      }];
    }).sort((a, b) => Date.parse(a.kickoffUtc) - Date.parse(b.kickoffUtc));

    return Response.json({
      fixtures,
      apiRequests,
      window: { fromUtc: startedAt.toISOString(), toUtc: endsAt.toISOString() },
      fetchedCandidates: rawFixtures.length,
      uniqueCandidates: uniqueRawFixtures.length,
      diagnostics: { queriedDates: dates, pageSize: PAGE_SIZE, truncated, missingId, invalidKickoff, outsideWindow },
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : '取得エラー', apiRequests }, { status: 502 });
  }
}
