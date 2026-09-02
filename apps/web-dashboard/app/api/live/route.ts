export const dynamic = 'force-dynamic';
export async function GET() {
  const apiKey = process.env.GOAL_API_KEY;
  if (!apiKey) return Response.json({ error: 'GOAL_API_KEYが未設定です' }, { status: 500 });
  const response = await fetch('https://api.goal-api.com/v1/fixtures/live', { headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' }, cache: 'no-store' });
  const payload = await response.json();
  if (!response.ok) return Response.json({ error: `GOAL API HTTP ${response.status}` }, { status: response.status });
  const raw = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.response) ? payload.response : [];
  const fixtures = raw.map((f: Record<string, any>) => ({ id:f.id??f.fixture_id??f.fixtureId,league:f.leagueName??f.league?.name??f.league_name??'Unknown league',country:f.countryName??f.league?.country?.name??f.country_name??'',home:f.homeTeamName??f.homeTeam?.name??f.match_hometeam_name??'Home',away:f.awayTeamName??f.awayTeam?.name??f.match_awayteam_name??'Away',homeScore:String(f.homeTeamScore??f.match_hometeam_score??'-'),awayScore:String(f.awayTeamScore??f.match_awayteam_score??'-'),status:String(f.matchStatus??f.match_status??f.status??'LIVE') })).filter((f: {id?:string}) => f.id);
  return Response.json({ fixtures });
}
