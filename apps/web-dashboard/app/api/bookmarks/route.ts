import { env } from 'cloudflare:workers';
import { ensureMonitorSchema } from '@/db/monitor';
import { canTransitionBookmarkStatus, isBookmarkStatus, normalizeBookmarkInput, type BookmarkStatus } from '@/lib/bookmarks';
import { writeGoalFixtureIdentity, type GoalFixtureInput } from '@/lib/goal-auto-form';

export const dynamic = 'force-dynamic';
const db = () => (env as unknown as { DB: D1Database }).DB;

export async function GET(request: Request) {
  const database = db(); await ensureMonitorSchema(database);
  const url = new URL(request.url); const includeRemoved = url.searchParams.get('includeRemoved') === 'true';
  const result = await database.prepare(`SELECT id, fixture_id AS fixtureId, home, away, league, country,
    kickoff_utc AS kickoffUtc, bookmarked_at AS bookmarkedAt, reason, related_team_id AS relatedTeamId,
    related_team_name AS relatedTeamName, status, monitor_source AS monitorSource,
    monitoring_started_at AS monitoringStartedAt, finished_at AS finishedAt, removed_at AS removedAt,
    updated_at AS updatedAt FROM fixture_bookmarks ${includeRemoved ? '' : "WHERE status != 'removed'"}
    ORDER BY CASE status WHEN 'monitoring' THEN 0 WHEN 'waiting' THEN 1 WHEN 'finished' THEN 2 ELSE 3 END, kickoff_utc`).all();
  return Response.json({ bookmarks: result.results });
}

export async function POST(request: Request) {
  let input; try { input = normalizeBookmarkInput(await request.json()); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : '入力エラー' }, { status: 400 }); }
  const database = db(); await ensureMonitorSchema(database); const now = new Date().toISOString();
  // Upcoming fixtures carry these official GOAL IDs.  A live/legacy bookmark
  // can lack them, in which case it remains raw-only rather than being joined
  // by names.  Identity failure must never discard the user's bookmark.
  let identity: { status: string; coreFixtureId?: string; reason?: string } | null = null;
  if (input.leagueId && input.homeTeamId && input.awayTeamId) {
    const goalFixture: GoalFixtureInput = {
      providerFixtureId: input.fixtureId, kickoffUtc: input.kickoffUtc,
      leagueId: input.leagueId, leagueName: input.league, country: input.country,
      homeTeamId: input.homeTeamId, awayTeamId: input.awayTeamId,
      homeTeamName: input.home, awayTeamName: input.away,
    };
    try { identity = await writeGoalFixtureIdentity(database, goalFixture); }
    catch (error) { identity = { status: 'ERROR', reason: error instanceof Error ? error.message : 'identity_write_failed' }; }
  }
  const existing = await database.prepare('SELECT status FROM fixture_bookmarks WHERE fixture_id = ?').bind(input.fixtureId).first<{ status: string }>();
  if (existing && existing.status !== 'removed') return Response.json({ error: '既にBookmark済みです', duplicate: true }, { status: 409 });
  if (existing) {
    await database.prepare(`UPDATE fixture_bookmarks SET home=?, away=?, league=?, country=?, kickoff_utc=?, bookmarked_at=?,
      reason=?, related_team_id=?, related_team_name=?, status='waiting', monitor_source='bookmark', monitoring_started_at=NULL,
      finished_at=NULL, removed_at=NULL, updated_at=? WHERE fixture_id=?`).bind(input.home,input.away,input.league,input.country,input.kickoffUtc,now,input.reason,input.relatedTeamId,input.relatedTeamName,now,input.fixtureId).run();
  } else {
    await database.prepare(`INSERT INTO fixture_bookmarks (fixture_id,home,away,league,country,kickoff_utc,bookmarked_at,reason,
      related_team_id,related_team_name,status,monitor_source,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,'waiting','bookmark',?)`)
      .bind(input.fixtureId,input.home,input.away,input.league,input.country,input.kickoffUtc,now,input.reason,input.relatedTeamId,input.relatedTeamName,now).run();
  }
  return Response.json({ saved: true, fixtureId: input.fixtureId, status: 'waiting', reactivated: Boolean(existing), identity }, { status: existing ? 200 : 201 });
}

export async function PATCH(request: Request) {
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const fixtureId = String(body.fixtureId ?? ''); const status = body.status;
  if (!fixtureId || !isBookmarkStatus(status)) return Response.json({ error: 'fixtureIdまたはstatusが不正です' }, { status: 400 });
  const database = db(); await ensureMonitorSchema(database); const now = new Date().toISOString();
  const current = await database.prepare('SELECT status FROM fixture_bookmarks WHERE fixture_id=?').bind(fixtureId).first<{ status: BookmarkStatus }>();
  if (!current) return Response.json({ error: 'Bookmarkが見つかりません' }, { status: 404 });
  if (!canTransitionBookmarkStatus(current.status, status)) return Response.json({ updated: false, ignored: true, fixtureId, status: current.status, reason: 'terminal_bookmark_cannot_reopen' });
  // Keep this condition in the UPDATE itself (rather than relying only on the
  // read above). The daemon can finish a fixture at the same time as its final
  // match_update is asynchronously marking it as monitoring. A stale
  // monitoring request must never reopen a row that has already become
  // finished.
  const result = await database.prepare(`UPDATE fixture_bookmarks SET status=?, updated_at=?,
    monitoring_started_at=CASE WHEN ?='monitoring' THEN COALESCE(monitoring_started_at,?) ELSE monitoring_started_at END,
    finished_at=CASE WHEN ?='finished' THEN COALESCE(finished_at,?) ELSE finished_at END,
    removed_at=CASE WHEN ?='removed' THEN ? WHEN ?!='removed' THEN NULL ELSE removed_at END
    WHERE fixture_id=?
      AND (status!='removed' OR ?='removed')
      AND NOT (status='finished' AND ?='monitoring')`)
    .bind(status,now,status,now,status,now,status,now,status,fixtureId,status,status).run();
  if (result.meta.changes) return Response.json({ updated: true, fixtureId, status });
  const latest = await database.prepare('SELECT status FROM fixture_bookmarks WHERE fixture_id=?').bind(fixtureId).first<{ status: BookmarkStatus }>();
  if (!latest) return Response.json({ error: 'Bookmarkが見つかりません' }, { status: 404 });
  return Response.json({ updated: false, ignored: true, fixtureId, status: latest.status, reason: 'terminal_bookmark_cannot_reopen' });
}

export async function DELETE(request: Request) {
  const fixtureId = new URL(request.url).searchParams.get('fixtureId');
  if (!fixtureId) return Response.json({ error: 'fixtureIdが必要です' }, { status: 400 });
  const database = db(); await ensureMonitorSchema(database); const now = new Date().toISOString();
  const result = await database.prepare("UPDATE fixture_bookmarks SET status='removed', removed_at=?, updated_at=? WHERE fixture_id=?")
    .bind(now,now,fixtureId).run();
  return result.meta.changes ? Response.json({ removed: true, fixtureId, historicalDataPreserved: true }) : Response.json({ error: 'Bookmarkが見つかりません' }, { status: 404 });
}
