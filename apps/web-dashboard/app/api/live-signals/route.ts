import { env } from 'cloudflare:workers';
import { ensureMonitorSchema } from '@/db/monitor';

export const dynamic = 'force-dynamic';

function database() { return (env as unknown as { DB: D1Database }).DB; }

export async function GET(request: Request) {
  const url = new URL(request.url);
  const fixtureIds = [...new Set((url.searchParams.get('fixtureIds') ?? '').split(',').map((value) => value.trim()).filter(Boolean))].slice(0, 25);
  const sessionId = url.searchParams.get('sessionId')?.trim();
  if (!fixtureIds.length || !sessionId) return Response.json({ signals: [] });
  const db = database(); await ensureMonitorSchema(db);
  const placeholders = fixtureIds.map(() => '?').join(',');
  const result = await db.prepare(`SELECT s.id,s.fixture_id AS fixtureId,s.signal_type AS ruleId,s.signal_version AS ruleVersion,
    s.signal_key AS signalSide,s.triggered_at AS triggeredAt,s.elapsed_minute AS detectedMinute,
    s.rule_parameters_json AS ruleParametersJson,s.feature_json AS featureJson,p.external_fixture_id AS providerFixtureId
    FROM live_signals s JOIN fixture_provider_ids p ON p.fixture_id=s.fixture_id AND p.provider='goal-api'
    WHERE p.external_fixture_id IN (${placeholders}) ORDER BY s.triggered_at DESC`).bind(...fixtureIds).all<{
      id:string; fixtureId:string; ruleId:string; ruleVersion:string; signalSide:string | null; triggeredAt:string; detectedMinute:number | null; ruleParametersJson:string; featureJson:string; providerFixtureId:string;
    }>();
  const rows = (result.results ?? []).map((row) => ({ ...row, ruleParameters: safelyParse(row.ruleParametersJson), feature: safelyParse(row.featureJson) }));
  const triggerIds = rows.map((row) => String((row.feature as Record<string, unknown> | null)?.triggerSnapshotId ?? '')).filter(Boolean);
  if (!triggerIds.length) return Response.json({ signals: [] });
  const triggerPlaceholders = triggerIds.map(() => '?').join(',');
  const observed = await db.prepare(`SELECT source_client_event_id FROM live_snapshots WHERE session_id=? AND source_client_event_id IN (${triggerPlaceholders})`).bind(sessionId, ...triggerIds).all<{ source_client_event_id: string }>();
  const observedIds = new Set((observed.results ?? []).map((row) => row.source_client_event_id));
  return Response.json({ signals: rows.filter((row) => observedIds.has(String((row.feature as Record<string, unknown> | null)?.triggerSnapshotId ?? ''))) });
}

function safelyParse(value: string) { try { return JSON.parse(value); } catch { return null; } }
