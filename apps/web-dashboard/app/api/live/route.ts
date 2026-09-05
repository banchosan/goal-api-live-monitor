export const dynamic = 'force-dynamic';
export async function GET() {
  const apiKey = process.env.GOAL_API_KEY;
  if (!apiKey) return Response.json({ error: 'GOAL_API_KEYが未設定です' }, { status: 500 });
  // Use /fixtures with status=LIVE and perform up to 3 paged requests (offsets 0,100,200).
  const base = 'https://api.goal-api.com/v1/fixtures';
  const offsets = [0, 100, 200];
  const limit = 100;
  const seen = new Set<string>();
  const fixtures: Array<Record<string, any>> = [];
  let apiCalls = 0;

  for (let i = 0; i < offsets.length; i++) {
    const offset = offsets[i];
    const url = new URL(base);
    url.searchParams.set('status', 'LIVE');
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('offset', String(offset));

    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' }, cache: 'no-store' });
    apiCalls += 1;
    let payload: any;
    try { payload = await res.json(); } catch (e) { return Response.json({ error: `GOAL API invalid JSON (offset=${offset})` }, { status: 502 }); }
    if (!res.ok) return Response.json({ error: `GOAL API HTTP ${res.status}` }, { status: res.status });

    const raw = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.response) ? payload.response : [];
    for (const f of raw) {
      const id = f.id ?? f.fixture_id ?? f.fixtureId;
      if (!id) continue;
      if (seen.has(id)) continue;
      seen.add(id);
      fixtures.push({ id, league: f.leagueName ?? f.league?.name ?? f.league_name ?? 'Unknown league', country: f.countryName ?? f.league?.country?.name ?? f.country_name ?? '', home: f.homeTeamName ?? f.homeTeam?.name ?? f.match_hometeam_name ?? 'Home', away: f.awayTeamName ?? f.awayTeam?.name ?? f.match_awayteam_name ?? 'Away', homeScore: String(f.homeTeamScore ?? f.match_hometeam_score ?? '-'), awayScore: String(f.awayTeamScore ?? f.match_awayteam_score ?? '-'), status: String(f.matchStatus ?? f.match_status ?? f.status ?? 'LIVE') });
    }

    if (Array.isArray(raw) && raw.length < limit) break;
  }

  console.info(`GOAL API /fixtures called ${apiCalls} time(s) to assemble ${fixtures.length} unique live fixtures`);
  return Response.json({ fixtures }, { headers: { 'X-GoalApi-Calls': String(apiCalls) } });
}
