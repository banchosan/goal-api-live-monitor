const DEFAULT_LEAD_MS = 3 * 60_000;

export class BookmarkScheduler {
  constructor({ collector, fetchImpl = fetch, dashboardUrl = 'http://localhost:3000', now = () => Date.now(), leadMs = DEFAULT_LEAD_MS } = {}) {
    this.collector = collector; this.fetchImpl = fetchImpl; this.dashboardUrl = dashboardUrl; this.now = now; this.leadMs = leadMs;
  }

  async tick() {
    const response = await this.fetchImpl(`${this.dashboardUrl}/api/bookmarks?includeRemoved=true`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`bookmarks HTTP ${response.status}`);
    const bookmarks = (await response.json()).bookmarks ?? [];
    const current = this.collector.status();
    const activeIds = new Set((current.fixtures ?? []).filter((f) => !f.ended).map((f) => String(f.id)));
    for (const bookmark of bookmarks.filter((b) => b.status === 'removed' && activeIds.has(String(b.fixtureId)))) {
      const fixture = current.fixtures.find((f) => String(f.id) === String(bookmark.fixtureId));
      if (fixture?.monitorSource === 'bookmark') await this.collector.remove(String(bookmark.fixtureId), 'bookmark_removed');
    }
    const refreshed = this.collector.status();
    const monitored = new Set((refreshed.fixtures ?? []).filter((f) => !f.ended).map((f) => String(f.id)));
    const slots = Math.max(0, 25 - monitored.size);
    const due = bookmarks.filter((b) => ['waiting', 'monitoring'].includes(b.status) && !monitored.has(String(b.fixtureId)) && (b.status === 'monitoring' || Date.parse(b.kickoffUtc) - this.leadMs <= this.now()))
      .sort((a, b) => Date.parse(a.kickoffUtc) - Date.parse(b.kickoffUtc)).slice(0, slots)
      .map((b) => ({ id:String(b.fixtureId),home:b.home,away:b.away,league:b.league,country:b.country,kickoffUtc:b.kickoffUtc,status:'SCHEDULED',homeScore:'-',awayScore:'-',monitorSource:'bookmark' }));
    if (due.length) refreshed.active ? await this.collector.add(due) : await this.collector.start(due);
    return { added: due.map((f) => f.id), queued: Math.max(0, bookmarks.filter((b) => ['waiting','monitoring'].includes(b.status) && !monitored.has(String(b.fixtureId)) && (b.status === 'monitoring' || Date.parse(b.kickoffUtc) - this.leadMs <= this.now())).length - due.length) };
  }
}
