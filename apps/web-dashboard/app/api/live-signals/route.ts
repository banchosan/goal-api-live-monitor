import { env } from 'cloudflare:workers';
import { ensureMonitorSchema } from '@/db/monitor';

export const dynamic = 'force-dynamic';

function database() { return (env as unknown as { DB: D1Database }).DB; }

export async function GET(request: Request) {
  const fixtureIds = [...new Set((new URL(request.url).searchParams.get('fixtureIds') ?? '').split(',').map((value) => value.trim()).filter(Boolean))].slice(0, 25);
  if (!fixtureIds.length) return Response.json({ signals: [] });
  const db = database(); await ensureMonitorSchema(db);
  const placeholders = fixtureIds.map(() => '?').join(',');
  const result = await db.prepare(`SELECT s.id,s.fixture_id AS fixtureId,s.signal_type AS ruleId,s.signal_version AS ruleVersion,
    s.signal_key AS signalSide,s.triggered_at AS triggeredAt,s.elapsed_minute AS detectedMinute,
    s.rule_parameters_json AS ruleParametersJson,s.feature_json AS featureJson,p.external_fixture_id AS providerFixtureId
    FROM live_signals s JOIN fixture_provider_ids p ON p.fixture_id=s.fixture_id AND p.provider='goal-api'
    WHERE p.external_fixture_id IN (${placeholders}) ORDER BY s.triggered_at DESC`).bind(...fixtureIds).all<{
      id:string; fixtureId:string; ruleId:string; ruleVersion:string; signalSide:string | null; triggeredAt:string; detectedMinute:number | null; ruleParametersJson:string; featureJson:string; providerFixtureId:string;
    }>();
  return Response.json({ signals: (result.results ?? []).map((row) => ({
    ...row,
    ruleParameters: safelyParse(row.ruleParametersJson), feature: safelyParse(row.featureJson),
  })) });
}

function safelyParse(value: string) { try { return JSON.parse(value); } catch { return null; } }
