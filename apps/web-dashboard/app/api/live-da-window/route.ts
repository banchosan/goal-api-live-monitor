import { env } from 'cloudflare:workers';
import { ensureMonitorSchema } from '@/db/monitor';
import { resolveDangerousAttacksWindow } from '@/lib/live-da-window';
import type { LiveSnapshot } from '@/lib/live-delta';

export const dynamic = 'force-dynamic';

function database() { return (env as unknown as { DB: D1Database }).DB; }

/** Read-only dashboard helper: returns the causal HT and <=65' checkpoints. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const fixtureIds = [...new Set((url.searchParams.get('fixtureIds') ?? '').split(',').map((value) => value.trim()).filter(Boolean))].slice(0, 25);
  const sessionId = url.searchParams.get('sessionId')?.trim();
  if (!fixtureIds.length || !sessionId) return Response.json({ windows: [] });
  const db = database(); await ensureMonitorSchema(db);
  const placeholders = fixtureIds.map(() => '?').join(',');
  const result = await db.prepare(`SELECT fixture_id,provider_fixture_id,source_client_event_id,provider_event_key,captured_at,elapsed_minute,added_time,match_status,
    home_score,away_score,shots_home,shots_away,shots_on_target_home,shots_on_target_away,corners_home,corners_away,
    attacks_home,attacks_away,dangerous_attacks_home,dangerous_attacks_away,yellow_cards_home,yellow_cards_away,
    red_cards_home,red_cards_away,saves_home,saves_away,passes_total_home,passes_total_away,passes_accurate_home,
    passes_accurate_away,possession_home,possession_away
    FROM live_snapshots
    WHERE provider='goal-api' AND session_id=? AND provider_fixture_id IN (${placeholders}) AND elapsed_minute IS NOT NULL AND elapsed_minute <= 65
    ORDER BY provider_fixture_id,captured_at,source_client_event_id`).bind(sessionId, ...fixtureIds).all<LiveSnapshot & { provider_fixture_id: string }>();
  const grouped = new Map<string, LiveSnapshot[]>();
  for (const row of result.results ?? []) {
    const providerFixtureId = (row as LiveSnapshot & { provider_fixture_id: string }).provider_fixture_id;
    const current = grouped.get(providerFixtureId) ?? [];
    current.push(row); grouped.set(providerFixtureId, current);
  }
  return Response.json({ windows: [...grouped.entries()].map(([providerFixtureId, snapshots]) => ({ providerFixtureId, window: resolveDangerousAttacksWindow(snapshots) })) }, { headers: { 'Cache-Control': 'no-store' } });
}
