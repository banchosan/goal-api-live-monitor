export const dynamic = 'force-dynamic';

const API_BASE = 'https://api.goal-api.com/v1';
// The published OpenAPI currently says 500, but the production API validates
// this parameter at 100. Keep the runtime-compatible value.
const PAGE_SIZE = 100;
const MAX_PAGES = 10;

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

export async function GET() {
  const apiKey = process.env.GOAL_API_KEY;
  if (!apiKey) return Response.json({ error: 'GOAL_API_KEYが未設定です', apiRequests: 0 }, { status: 500 });

  const startedAt = new Date();
  const endsAt = new Date(startedAt.getTime() + 24 * 60 * 60 * 1000);
  const rawFixtures: RawFixture[] = [];
  let offset = 0;
  let apiRequests = 0;

  try {
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const query = new URLSearchParams({
        from: utcDate(startedAt),
        to: utcDate(endsAt),
        status: 'SCHEDULED',
        limit: String(PAGE_SIZE),
        offset: String(offset),
      });
      const response = await fetch(`${API_BASE}/fixtures?${query}`, {
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
      rawFixtures.push(...pageFixtures);
      if (!payload?.pagination?.hasMore || pageFixtures.length === 0) break;
      offset += pageFixtures.length;
    }

    const startMs = startedAt.getTime();
    const endMs = endsAt.getTime();
    const fixtures = rawFixtures.flatMap((fixture) => {
      const kickoffUtc = kickoffValue(fixture);
      const kickoffMs = kickoffUtc ? Date.parse(kickoffUtc) : Number.NaN;
      const id = fixture.id ?? fixture.fixture_id ?? fixture.fixtureId;
      if (!id || !Number.isFinite(kickoffMs) || kickoffMs < startMs || kickoffMs > endMs) return [];
      return [{
        id: String(id),
        league: fixture.leagueName ?? fixture.league?.name ?? fixture.league_name ?? 'Unknown league',
        country: fixture.countryName ?? fixture.league?.country?.name ?? fixture.country_name ?? '',
        home: fixture.homeTeamName ?? fixture.homeTeam?.name ?? fixture.match_hometeam_name ?? 'Home',
        away: fixture.awayTeamName ?? fixture.awayTeam?.name ?? fixture.match_awayteam_name ?? 'Away',
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
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : '取得エラー', apiRequests }, { status: 502 });
  }
}
