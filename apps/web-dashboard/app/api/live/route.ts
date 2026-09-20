export const dynamic = 'force-dynamic';
import { fetchAllLiveFixtures } from '../../../lib/live-fixtures';
import { goalLiveFixtureContext } from '../../../lib/goal-live-fixture-context';

type RawFixture = Record<string, unknown>;

export async function GET() {
  const apiKey = process.env.GOAL_API_KEY;
  if (!apiKey) return Response.json({ error: 'GOAL_API_KEYが未設定です' }, { status: 500 });
  try {
    const result = await fetchAllLiveFixtures(apiKey);
    const fixtures = result.fixtures.map((f: RawFixture) => goalLiveFixtureContext(f));
    console.info(`GOAL API /fixtures called ${result.apiCalls} time(s) to assemble ${fixtures.length} unique LIVE/HALF_TIME fixtures`);
    return Response.json(
      { fixtures, apiRequests: result.apiCalls, pages: result.pages, warnings: result.errors },
      { headers: { 'X-GoalApi-Calls': String(result.apiCalls) } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'GOAL API request failed';
    return Response.json({ error: message }, { status: 502 });
  }
}
