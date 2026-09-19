import { MAX_CONCURRENT_LIVE_FIXTURES } from './monitoring-limits.mjs';
const DEFAULT_LEAD_MS = 3 * 60_000;

export class BookmarkScheduler {
  constructor({ collector, fetchImpl = fetch, dashboardUrl = 'http://localhost:3000', now = () => Date.now(), leadMs = DEFAULT_LEAD_MS } = {}) {
    this.collector = collector; this.fetchImpl = fetchImpl; this.dashboardUrl = dashboardUrl; this.now = now; this.leadMs = leadMs;
  }

  async tick() {
    const requestOptions = { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) };
    const [response, exclusionResponse] = await Promise.all([
      this.fetchImpl(`${this.dashboardUrl}/api/bookmarks?includeRemoved=true`, requestOptions),
      this.fetchImpl(`${this.dashboardUrl}/api/monitor-exclusions`, requestOptions),
    ]);
    if (!response.ok) throw new Error(`bookmarks HTTP ${response.status}`);
    if (!exclusionResponse.ok) throw new Error(`monitor exclusions HTTP ${exclusionResponse.status}`);
    const bookmarks = (await response.json()).bookmarks ?? [];
    const excludedIds = new Set(((await exclusionResponse.json()).exclusions ?? []).map((row) => String(row.fixtureId)));
    let current = this.collector.status();
    for (const fixture of (current.fixtures ?? []).filter((item) => !item.ended && excludedIds.has(String(item.id)))) {
      await this.collector.remove(String(fixture.id), 'persistent_monitor_exclusion');
    }
    const refreshed = this.collector.status();
    const monitored = new Set((refreshed.fixtures ?? []).filter((f) => !f.ended).map((f) => String(f.id)));
    const slots = Math.max(0, MAX_CONCURRENT_LIVE_FIXTURES - monitored.size);
    const eligible = bookmarks.filter((b) => ['waiting', 'monitoring'].includes(b.status) && !excludedIds.has(String(b.fixtureId)) && !monitored.has(String(b.fixtureId)) && (b.status === 'monitoring' || Date.parse(b.kickoffUtc) - this.leadMs <= this.now()));
    const due = eligible
      .sort((a, b) => Date.parse(a.kickoffUtc) - Date.parse(b.kickoffUtc)).slice(0, slots)
      .map((b) => ({ id:String(b.fixtureId),home:b.home,away:b.away,league:b.league,country:b.country,kickoffUtc:b.kickoffUtc,status:'SCHEDULED',homeScore:'-',awayScore:'-',monitorSource:b.monitorSource === 'auto_form' ? 'auto_form' : 'bookmark' }));
    if (due.length) refreshed.active ? await this.collector.add(due) : await this.collector.start(due);
    return { added: due.map((f) => f.id), queued: Math.max(0, eligible.length - due.length), excluded: [...excludedIds] };
  }
}
