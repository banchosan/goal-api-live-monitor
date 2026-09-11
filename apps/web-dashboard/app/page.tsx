'use client';

import './bookmarks.css';

import { useEffect, useMemo, useRef, useState } from 'react';
import { visibleCollectorFixtures, withoutFixture } from '@/lib/live-monitor-state';
import { displayMatchMinute } from '@/lib/live-minute';
import { readJsonResponse, responseFailureMessage } from '@/lib/safe-json-response';
import { isGoalProviderPlaceholderZeroPair } from '@/lib/live-stat-availability';

type Fixture = { id: string; league: string; country: string; home: string; away: string; homeScore: string; awayScore: string; status: string; kickoffUtc?: string };
type UpcomingFixture = { id: string; league: string; country: string; home: string; away: string; homeTeamId: string; awayTeamId: string; kickoffUtc: string; kickoffJst: string; status: string };
type FormCandidate = { kickoffUtc: string; kickoffJst: string; league: string; country: string; fixtureId: string; home:string; away:string; homeTeamId:string; awayTeamId:string; teamId:string; team: string; side: 'home' | 'away'; opponent: string; wins: number; draws: number; last5: { result: string; score: string; opponent: string; fixtureId: string }[] };
type Stat = { type: string; home: string | number | null; away: string | number | null };
type ManualSnapshot = { id: string; status: string; capturedAt: string; stats: Stat[] };
type LiveMatch = Fixture & { stats: Stat[]; updatedAt?: string; lastReceivedAt?: string; updates: number; ended?: boolean; htStats?: Stat[] | null; sixtyStats?: Stat[] | null; sixtyMinute?: number | null; subscriptionState?: string; subscribedAt?: string | null; snapshots: ManualSnapshot[]; selectedSnapshotId?: string };
type MonitorEvent = { sessionId: string; fixtureId: string; eventType: string; receivedAt: string; status?: string; home?: string; away?: string; homeScore?: string; awayScore?: string; payload: unknown };
type Bookmark = { fixtureId:string;home:string;away:string;league:string;country:string;kickoffUtc:string;reason:string;relatedTeamName?:string|null;status:'waiting'|'monitoring'|'finished'|'removed';updatedAt:string };
type MonitorExclusion = { fixtureId:string;home:string;away:string;reason:string;excludedAt:string;updatedAt:string };

export default function Home() {
  const [viewMode, setViewMode] = useState<'live' | 'upcoming'>('live');
  const [fixtures, setFixtures] = useState<Fixture[]>([]);
  const [upcomingFixtures, setUpcomingFixtures] = useState<UpcomingFixture[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [matches, setMatches] = useState<Record<string, LiveMatch>>({});
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [upcomingLoading, setUpcomingLoading] = useState(false);
  const [upcomingMessage, setUpcomingMessage] = useState('「今後24時間を取得」を押してください');
  const [connection, setConnection] = useState<'idle' | 'connecting' | 'live' | 'error'>('idle');
  const [message, setMessage] = useState('「ライブ試合を取得」を押してください');
  const [restCount, setRestCount] = useState(0);
  const [frameCount, setFrameCount] = useState(0);
  const [collectorRequests, setCollectorRequests] = useState(0);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [monitorExclusions, setMonitorExclusions] = useState<MonitorExclusion[]>([]);
  const [bookmarkMessage, setBookmarkMessage] = useState('');
  const sessionIdRef = useRef('');
  const matchesRef = useRef<Record<string, LiveMatch>>({});
  const hiddenFixtureIdsRef = useRef(new Set<string>());
  const excludedFixtureIdsRef = useRef(new Set<string>());
  const visible = useMemo(() => fixtures.filter((f) => `${f.home} ${f.away} ${f.league} ${f.country}`.toLowerCase().includes(query.toLowerCase())), [fixtures, query]);
  const additionalIds = selected.filter((id) => !matches[id] && !monitorExclusions.some((row) => row.fixtureId === id));
  const availableSlots = Math.max(0, 25 - Object.keys(matches).length);
  const addableIds = additionalIds.slice(0, availableSlots);

  async function loadBookmarks() { try { const response=await fetch('/api/bookmarks',{cache:'no-store'}); if(response.ok)setBookmarks((await response.json()).bookmarks??[]); } catch {} }
  async function loadMonitorExclusions() { try { const response=await fetch('/api/monitor-exclusions',{cache:'no-store'}); if(response.ok){const rows=(await response.json()).exclusions??[];excludedFixtureIdsRef.current=new Set(rows.map((row:MonitorExclusion)=>String(row.fixtureId)));setMonitorExclusions(rows);} } catch {} }
  async function bookmarkFixture(fixture: { id:string;home:string;away:string;league:string;country:string;kickoffUtc?:string }, reason='manual', relatedTeamId?:string, relatedTeamName?:string) {
    try { const response=await fetch('/api/bookmarks',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({fixtureId:fixture.id,home:fixture.home,away:fixture.away,league:fixture.league,country:fixture.country,kickoffUtc:fixture.kickoffUtc??new Date().toISOString(),reason,relatedTeamId,relatedTeamName})}); const data=await response.json(); if(!response.ok)throw new Error(data.error);setBookmarkMessage(`${fixture.home} vs ${fixture.away}をBookmarkしました`);await loadBookmarks(); }
    catch(error){setBookmarkMessage(error instanceof Error?error.message:'Bookmark失敗')}
  }
  async function removeBookmark(fixtureId:string){await fetch(`/api/bookmarks?fixtureId=${encodeURIComponent(fixtureId)}`,{method:'DELETE'});await loadBookmarks()}
  async function restoreMonitoring(fixtureId:string){const response=await fetch(`/api/monitor-exclusions?fixtureId=${encodeURIComponent(fixtureId)}`,{method:'DELETE'});if(response.ok){excludedFixtureIdsRef.current.delete(fixtureId);hiddenFixtureIdsRef.current.delete(fixtureId);await loadMonitorExclusions();setMessage('監視除外を解除しました。Bookmark済みならschedulerが再び監視へ追加します。');}}

  async function loadFixtures() {
    setLoading(true); setMessage('GOAL APIからライブ試合を取得中…');
    try {
      const response = await fetch('/api/live', { cache: 'no-store', signal: AbortSignal.timeout(30_000) });
      const data = await response.json();
      const headerCalls = Number(response.headers.get('X-GoalApi-Calls'));
      setRestCount((v) => v + Number(data.apiRequests ?? (Number.isFinite(headerCalls) ? headerCalls : 1)));
      if (!response.ok) throw new Error(data.error || 'ライブ一覧を取得できませんでした');
      const warning = Array.isArray(data.warnings) && data.warnings.length ? ` 一部取得失敗: ${data.warnings.map((item: { status: string; reason: string }) => `${item.status} ${item.reason}`).join(' / ')}` : '';
      setFixtures(data.fixtures); setMessage(`${data.fixtures.length}試合を取得しました（GOAL API ${data.apiRequests ?? headerCalls} REST request）。監視する試合を選択してください。${warning}`);
    } catch (error) { setMessage(error instanceof Error && error.name === 'TimeoutError' ? 'ライブ取得が30秒でタイムアウトしました。GOAL API側の一時障害です。少し待って再実行してください。' : error instanceof Error ? error.message : '取得エラー'); }
    finally { setLoading(false); }
  }

  async function loadUpcomingFixtures() {
    setUpcomingLoading(true); setUpcomingMessage('GOAL APIから今後24時間の試合を取得中…');
    try {
      const response = await fetch('/api/upcoming', { cache: 'no-store' });
      const data = await response.json();
      setRestCount((v) => v + Number(data.apiRequests ?? 1));
      if (!response.ok) throw new Error(data.error || '今後24時間の試合を取得できませんでした');
      setUpcomingFixtures(data.fixtures ?? []);
      const diagnostics = data.diagnostics ?? {};
      const detail = data.fixtures.length === 0
        ? ` 候補${data.uniqueCandidates ?? data.fetchedCandidates ?? 0}件／日時解析失敗${diagnostics.invalidKickoff ?? 0}件／24時間外${diagnostics.outsideWindow ?? 0}件。`
        : diagnostics.truncated ? ' APIの安全上限に達したため一部のみです。' : '';
      setUpcomingMessage(`${data.fixtures.length}試合を取得しました（GOAL API ${data.apiRequests} REST request）。${detail}`);
    } catch (error) { setUpcomingMessage(error instanceof Error ? error.message : '取得エラー'); }
    finally { setUpcomingLoading(false); }
  }

  function toggle(id: string) { setSelected((now) => now.includes(id) ? now.filter((v) => v !== id) : now.length < 25 ? [...now, id] : now); }

  async function startMonitoring() {
    if (!selected.length) return;
    setConnection('connecting'); setMessage('Collectorへ監視開始を依頼中…');
    const monitorable = selected.filter((id) => !excludedFixtureIdsRef.current.has(id));
    const initialMatches = Object.fromEntries(monitorable.map((id) => { const f = fixtures.find((x) => x.id === id)!; return [id, { ...f, stats: [], updates: 0, snapshots: [] }]; }));
    setMatches(initialMatches);
    try {
      const response = await fetch('/api/collector', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'start', fixtures: Object.values(initialMatches) }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Collector開始失敗');
      sessionIdRef.current = body.sessionId ?? '';
    } catch (error) { setConnection('error'); setMessage(error instanceof Error ? error.message : '接続エラー'); }
  }

  function addSelectedMatches() {
    if (connection !== 'live' || !addableIds.length) return;
    for (const id of addableIds) hiddenFixtureIdsRef.current.delete(id);
    setMatches((now) => {
      const additions = Object.fromEntries(addableIds.map((id) => {
        const fixture = fixtures.find((item) => item.id === id)!;
        return [id, { ...fixture, stats: [], updates: 0, snapshots: [] }];
      }));
      return { ...now, ...additions };
    });
    void fetch('/api/collector', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'add', fixtures: addableIds.map((id) => fixtures.find((item) => item.id === id)) }) }).then(async (response) => { const body = await response.json(); if (!response.ok) throw new Error(body.error); setMessage(`${addableIds.length}試合を現在のCollectorへ追加しました。GOAL API REST消費は0です。`); }).catch((error) => setMessage(error instanceof Error ? error.message : '追加失敗'));
  }

  function stopMonitoring() {
    setConnection('idle'); setMessage('Collectorを停止中…');
    void fetch('/api/collector', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'stop' }) }).then(() => setMessage('監視を停止しました。手動停止後は再接続しません。')).catch(() => setMessage('Collector停止を確認できませんでした'));
  }

  async function removeFromMonitoring(id: string) {
    try {
      const match = matchesRef.current[id];
      const exclusion = await fetch('/api/monitor-exclusions', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({fixtureId:id,home:match?.home??'',away:match?.away??'',reason:'manual_fixture_unsubscribe'}) });
      if (!exclusion.ok) throw new Error((await exclusion.json().catch(()=>({}))).error || '監視除外の保存に失敗しました');
      excludedFixtureIdsRef.current.add(id);
      await loadMonitorExclusions();
      const response = await fetch('/api/collector', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'remove', fixtureId: id, reason: 'manual_fixture_unsubscribe' }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || '個別解除に失敗しました');
      hiddenFixtureIdsRef.current.add(id);
      setMatches((now) => withoutFixture(now, id));
      setSelected((now) => now.filter((fixtureId) => fixtureId !== id));
      setMessage('対象試合を永続的な監視除外リストへ移しました。Bookmarkと過去データは保持されています。');
    } catch (error) { setMessage(error instanceof Error ? error.message : '個別解除に失敗しました'); }
  }

  async function hideFinishedFixture(id: string) {
    const match = matchesRef.current[id];
    const response = await fetch('/api/monitor-exclusions', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({fixtureId:id,home:match?.home??'',away:match?.away??'',reason:'finished_fixture_hidden'}) });
    if (!response.ok) { setMessage('終了試合の監視除外保存に失敗しました。'); return; }
    excludedFixtureIdsRef.current.add(id); await loadMonitorExclusions();
    hiddenFixtureIdsRef.current.add(id);
    setMatches((now) => withoutFixture(now, id));
    setSelected((now) => now.filter((fixtureId) => fixtureId !== id));
    setMessage('終了試合を画面から外しました。raw/D1/timelineの履歴は保持されています。');
  }

  async function refreshSubscription(id: string) {
    try {
      const response = await fetch('/api/collector', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'refresh', fixtureId: id, reason: 'manual_dashboard_resubscribe' }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || '再subscribeに失敗しました');
      setMessage('対象試合を再subscribeしました。GOAL API REST消費は0です。');
    } catch (error) { setMessage(error instanceof Error ? error.message : '再subscribeに失敗しました'); }
  }

  function captureSnapshot(id: string) {
    const match = matchesRef.current[id];
    if (!match || !match.stats.length) return;
    const capturedAt = new Date().toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo' });
    const snapshot: ManualSnapshot = { id: `${Date.now()}-${match.snapshots.length}`, status: match.status, capturedAt, stats: match.stats.map((stat) => ({ ...stat })) };
    setMatches((now) => ({ ...now, [id]: { ...now[id], snapshots: [...now[id].snapshots, snapshot], selectedSnapshotId: snapshot.id } }));
    persistEvents([eventFromMatch(sessionIdRef.current, match, 'manual_snapshot', snapshot)]);
  }

  function selectSnapshot(id: string, snapshotId: string) {
    setMatches((now) => {
      const match = now[id];
      if (!match) return now;
      return { ...now, [id]: { ...match, selectedSnapshotId: match.selectedSnapshotId === snapshotId ? undefined : snapshotId } };
    });
  }
  useEffect(() => { matchesRef.current = matches; }, [matches]);
  useEffect(() => { void loadBookmarks(); void loadMonitorExclusions(); const timer=window.setInterval(()=>{void loadBookmarks();void loadMonitorExclusions();},5000); return()=>window.clearInterval(timer); }, []);
  useEffect(() => {
    let cancelled = false;
    const sync = async () => {
      try {
        const response = await fetch('/api/collector', { cache: 'no-store' }); if (!response.ok) throw new Error();
        const data = await response.json(); if (cancelled) return;
        sessionIdRef.current = data.sessionId ?? ''; setCollectorRequests(Number(data.goalApiRequests ?? 0));
        setFrameCount((data.fixtures ?? []).reduce((sum: number, fixture: LiveMatch) => sum + Number(fixture.updates ?? 0), 0));
        if (data.fixtures?.length) { const hidden=new Set([...hiddenFixtureIdsRef.current,...excludedFixtureIdsRef.current]); setMatches((current) => Object.fromEntries(visibleCollectorFixtures(data.fixtures as LiveMatch[], hidden).map((fixture) => [fixture.id, { ...fixture, updatedAt: fixture.updatedAt ? new Date(fixture.updatedAt).toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo' }) : undefined, snapshots: current[fixture.id]?.snapshots ?? [], selectedSnapshotId: current[fixture.id]?.selectedSnapshotId }]))); }
        if (data.active && data.connectionState === 'live') { setConnection('live'); setMessage(`${data.fixtures.length}試合を独立Collectorで監視中。ブラウザを再読込しても収集は継続します。`); }
        else if (data.active) { setConnection('connecting'); setMessage(data.connectionState === 'reconnect_wait' ? `Socket切断を検知。再接続待機中（試行 ${data.reconnectAttempt}）` : 'CollectorがWebSocketへ接続中…'); }
        else setConnection((value) => value === 'error' ? value : 'idle');
      } catch { if (!cancelled) { setConnection('error'); setMessage('Collector daemonへ接続できません。起動スクリプトから再起動してください。'); } }
    };
    void sync(); const timer = window.setInterval(sync, 1000); return () => { cancelled = true; window.clearInterval(timer); };
  }, []);

  return <main className="app-shell">
    <header className="topbar">
      <div className="brand"><span className="brand-ball">G</span><div><strong>GOAL LIVE</strong><small>WebSocket Stats Lab</small></div></div>
      <a className="odds-nav" href="/odds">オッズ一覧</a>
      <a className="odds-nav" href="/analysis">分析データ</a>
      <a className="odds-nav" href="/form-history">調子分析履歴</a>
      <div className="health"><span className={`dot ${connection}`} />{connection === 'live' ? 'SOCKET CONNECTED' : connection === 'connecting' ? 'CONNECTING' : connection === 'error' ? 'CONNECTION ERROR' : 'SOCKET OFF'}</div>
      <div className="quota"><span>HTTP USED</span><strong>{restCount + collectorRequests}</strong><small>WS updates {frameCount}</small></div>
    </header>
    <nav className="view-tabs" aria-label="表示切替"><button className={viewMode === 'live' ? 'active' : ''} onClick={() => setViewMode('live')}>ライブ監視</button><button className={viewMode === 'upcoming' ? 'active' : ''} onClick={() => setViewMode('upcoming')}>今後24時間</button></nav>
    <BookmarkPanel bookmarks={bookmarks} exclusions={monitorExclusions} matches={matches} message={bookmarkMessage} onRemove={removeBookmark} onRestoreMonitoring={restoreMonitoring} />
    <section className="commandbar"><div><h1>{viewMode === 'live' ? 'ライブ試合を選んで、リアルタイムで見る。' : 'これから24時間以内に始まる全試合。'}</h1><p>{viewMode === 'live' ? message : upcomingMessage}</p></div><div className="actions">
      {viewMode === 'live' ? <><button className="secondary" onClick={loadFixtures} disabled={loading}>{loading ? '取得中…' : fixtures.length ? '一覧を更新' : 'ライブ試合を取得'}</button>
      {connection === 'live' ? <><button className="primary" onClick={addSelectedMatches} disabled={!addableIds.length || !availableSlots}>選択から{addableIds.length}試合を追加</button><button className="danger" onClick={stopMonitoring}>監視を停止</button></> : connection === 'connecting' ? <button className="danger" onClick={stopMonitoring}>接続を中止</button> : <button className="primary" onClick={startMonitoring} disabled={!selected.length}>選択した{selected.length}試合を監視</button>}</> : <button className="primary" onClick={loadUpcomingFixtures} disabled={upcomingLoading}>{upcomingLoading ? '取得中…' : upcomingFixtures.length ? '24時間一覧を更新' : '今後24時間を取得'}</button>}
    </div></section>
    {viewMode === 'live' ? <div className="workspace">
      <aside className="match-picker"><div className="picker-head"><div><span className="eyebrow">LIVE MATCHES</span><strong>{fixtures.length}</strong></div><span className="selection-count">{selected.length}/25 選択</span></div>
        <input aria-label="試合検索" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="チーム・リーグを検索" />
        <div className="fixture-list">{!fixtures.length && <div className="empty"><span>◉</span><p>まだ一覧を取得していません</p><small>LIVE/HTを各1ページ取得。100件超は次ページ分を追加します</small></div>}
          {visible.map((f) => <div key={f.id} className={`fixture ${selected.includes(f.id) ? 'chosen' : ''}`}><input aria-label={`${f.home} vs ${f.away}を選択`} type="checkbox" checked={selected.includes(f.id)} onChange={() => toggle(f.id)} /><div className="fixture-main"><small>{f.country} · {f.league}</small><div><span>{f.home}</span><b>{f.homeScore}</b></div><div><span>{f.away}</span><b>{f.awayScore}</b></div></div><span className="minute">{displayMatchMinute(f.status)}<button className="bookmark-mini" disabled={bookmarks.some(b=>b.fixtureId===f.id)} onClick={()=>void bookmarkFixture(f,'live-manual')}>★</button></span></div>)}
        </div>
      </aside>
      <section className="score-stage">{!Object.keys(matches).length && <div className="hero-empty"><div className="pulse-rings"><span /><span /><b>⚽</b></div><h2>試合を選択してください</h2><p>左のライブ一覧から最大25試合を選び、1本のSocketで同時監視できます。</p><div className="flow"><span>LIVE LIST<small>通常2 REST</small></span><i>→</i><span>SELECT<small>最大25試合</small></span><i>→</i><span>WEBSOCKET<small>更新消費 0</small></span></div></div>}
        <div className="cards-grid">{Object.values(matches).map((m) => <MatchCard key={m.id} match={m} onCapture={() => captureSnapshot(m.id)} onSelectSnapshot={(snapshotId) => selectSnapshot(m.id, snapshotId)} onRemove={() => m.ended ? void hideFinishedFixture(m.id) : void removeFromMonitoring(m.id)} onRefresh={() => void refreshSubscription(m.id)} />)}</div>
      </section>
    </div> : <UpcomingBoard fixtures={upcomingFixtures} loading={upcomingLoading} onRest={(count) => setRestCount((value) => value + count)} bookmarks={bookmarks} onBookmark={bookmarkFixture} />}
  </main>;
}

function UpcomingBoard({ fixtures, loading, onRest, bookmarks, onBookmark }: { fixtures: UpcomingFixture[]; loading: boolean; onRest: (count: number) => void; bookmarks:Bookmark[]; onBookmark:(fixture:UpcomingFixture,reason?:string,relatedTeamId?:string,relatedTeamName?:string)=>Promise<void> }) {
  const [scope, setScope] = useState<'all' | 'big5'>('big5');
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisMessage, setAnalysisMessage] = useState('');
  const [candidates, setCandidates] = useState<FormCandidate[]>([]);
  const [formRunId, setFormRunId] = useState('');
  const [oddsLoading, setOddsLoading] = useState(false);
  const [oddsMessage, setOddsMessage] = useState('');
  const shown = scope === 'big5' ? fixtures.filter(isSelectedLeague) : fixtures;
  const uniqueTeams = new Set(shown.flatMap((fixture) => [fixture.homeTeamId, fixture.awayTeamId]).filter(Boolean)).size;

  async function analyzeForm() {
    if (!shown.length || analyzing) return;
    setAnalyzing(true); setCandidates([]); setAnalysisMessage(`${uniqueTeams}チームの直近5試合を確認中…`);
    try {
      const response = await fetch('/api/form-candidates', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fixtures: shown }) });
      const data = await response.json();
      onRest(Number(data.apiRequests ?? 0));
      if (!response.ok) throw new Error(data.error || '直近成績を取得できませんでした');
      setCandidates(data.candidates ?? []);
      setFormRunId(data.runId ?? '');
      setOddsMessage('');
      const outcomes = Object.entries(data.outcomeCounts ?? {}).map(([name, count]) => `${name} ${count}`).join(' / ');
      const typed=data.typed;const typedMessage=typed?` typed form: 保存 ${typed.saved ?? 0} / 既存 ${typed.existing ?? 0} / 保留 ${typed.skipped ?? 0} / error ${typed.error ?? 0}。`:'';
      setAnalysisMessage(`${data.checkedTeams}チームを${data.apiRequests} RESTで確認（retry ${data.retryCount ?? 0}）。最終候補は${data.candidates.length}チーム（直近2戦 LL / DL / LD により${data.excludedCount ?? 0}チーム除外）${data.failedTeams ? `（取得失敗 ${data.failedTeams}）` : ''}。${outcomes ? `内訳: ${outcomes}。` : ''}${data.saved ? '分析結果を履歴保存しました。' : '結果の保存だけ失敗しました。'}${typedMessage}`);
    } catch (error) { setAnalysisMessage(error instanceof Error ? error.message : '分析エラー'); }
    finally { setAnalyzing(false); }
  }

  async function fetchCandidateOdds() {
    if (!candidates.length || oddsLoading) return;
    setOddsLoading(true); setOddsMessage('API-Footballから候補試合のオッズを取得中… 毎分制限のため数分かかる場合があります。');
    try {
      const response = await fetch('/api/candidate-odds', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ formRunId, candidates }) });
      const parsed = await readJsonResponse<any>(response);
      if (!parsed.ok) throw new Error(responseFailureMessage(parsed, 'オッズ取得画面への応答'));
      const data = parsed.data;
      if (!response.ok) throw new Error(data.error || 'オッズ取得に失敗しました');
      const identity=data.identity;const identityMessage=identity?` fixture identity: 保存 ${identity.saved ?? 0} / 既存 ${identity.noop ?? 0} / 保留 ${identity.skipped ?? 0} / conflict ${identity.conflict ?? 0}。`:'';const typed=data.typed;const typedMessage=typed?` typed odds: capture ${typed.captureRuns ?? 0} / markets ${typed.markets ?? typed.saved ?? 0} / 保留 ${identity?.skipped ?? 0} / malformed ${typed.malformed ?? 0} / error ${typed.error ?? 0}。`:'';
      const failures=Array.isArray(data.failures)&&data.failures.length?` API失敗 ${data.failures.length}件（${data.failures.map((failure:any)=>`${failure.endpoint} ${failure.status||failure.kind}`).join(' / ')}）。`:'';
      setOddsMessage(`${data.matched}試合の全オッズを${data.apiRequests} API-Football RESTで取得・履歴保存しました。未一致 ${data.unmatched.length}試合。${identityMessage}${typedMessage}${failures}`);
    } catch (error) { setOddsMessage(error instanceof Error ? error.message : 'オッズ取得エラー'); }
    finally { setOddsLoading(false); }
  }

  return <section className="upcoming-stage">
    {!fixtures.length ? <div className="hero-empty upcoming-empty"><div className="pulse-rings"><span /><span /><b>24h</b></div><h2>{loading ? '試合一覧を取得しています' : 'まだ試合を取得していません'}</h2><p>取得ボタン1回で、現在時刻から24時間以内にキックオフする試合だけを表示します。</p></div> : <>
      <div className="scope-panel"><div><button className={scope === 'big5' ? 'active' : ''} onClick={() => { setScope('big5'); setCandidates([]); setAnalysisMessage(''); }}>指定リーグ</button><button className={scope === 'all' ? 'active' : ''} onClick={() => { setScope('all'); setCandidates([]); setAnalysisMessage(''); }}>全試合</button></div><button className="analyze-button" disabled={analyzing || !shown.length || uniqueTeams > 250} onClick={analyzeForm}>{analyzing ? '分析中…' : `直近5試合を分析（最大 ${uniqueTeams} REST）`}</button></div>
      <div className="scope-note">絞り込みは取得済みfixture内で行うため追加REST 0。直近成績はユニークteamごとに1 RESTです。</div>
      <div className="upcoming-summary"><span>{scope === 'big5' ? 'SELECTED LEAGUES' : 'UPCOMING FIXTURES'}</span><strong>{shown.length}</strong><small>現在時刻から24時間以内・JST順 · {uniqueTeams}チーム</small></div>
      {analysisMessage && <div className="analysis-message">{analysisMessage}</div>}
      {candidates.length > 0 && <div className="odds-fetch-row"><button disabled={oddsLoading} onClick={fetchCandidateOdds}>{oddsLoading ? 'オッズ取得・保存中…' : `候補${new Set(candidates.map(c => c.fixtureId)).size}試合のオッズを取得・保存`}</button><a href="/odds">保存済みオッズを見る →</a></div>}
      {oddsMessage && <div className="analysis-message">{oddsMessage}</div>}
      {candidates.length > 0 && <section className="candidate-section"><div className="candidate-title"><span>WATCH CANDIDATES</span><strong>4勝以上 または 3勝＋1分以上（直近2戦 LL / DL / LD は除外）</strong></div><div className="candidate-grid">{candidates.map((candidate) => {const fixture=fixtures.find(f=>f.id===candidate.fixtureId);return <article className="candidate-card" key={`${candidate.fixtureId}-${candidate.team}`}><div><time>{candidate.kickoffJst} JST</time><b>{candidate.wins}W {candidate.draws}D / 5</b></div><h3>{candidate.team}</h3><p>{candidate.side.toUpperCase()} vs {candidate.opponent}</p><small>{candidate.country} · {candidate.league}</small><div className="form-strip">{candidate.last5.map((result, index) => <span className={result.result.toLowerCase()} title={`${result.opponent} ${result.score}`} key={`${result.fixtureId}-${index}`}>{result.result}</span>)}</div>{fixture&&<button className="bookmark-button" disabled={bookmarks.some(b=>b.fixtureId===fixture.id)} onClick={()=>void onBookmark(fixture,'good-form',candidate.teamId,candidate.team)}>★ 好調候補をBookmark</button>}</article>})}</div></section>}
      <div className="upcoming-list">{shown.map((fixture) => <article className="upcoming-row" key={fixture.id}>
        <time dateTime={fixture.kickoffUtc}><strong>{fixture.kickoffJst}</strong><small>JST</small></time>
        <div className="upcoming-teams"><span>{fixture.home}</span><i>vs</i><span>{fixture.away}</span></div>
        <div className="upcoming-meta"><strong>{fixture.country}</strong><span>{fixture.league}</span><code>{fixture.id}</code><button className="bookmark-button" disabled={bookmarks.some(b=>b.fixtureId===fixture.id)} onClick={()=>void onBookmark(fixture,'upcoming-manual')}>★ Bookmark</button></div>
      </article>)}</div>
    </>}
  </section>;
}

function BookmarkPanel({bookmarks,exclusions,matches,message,onRemove,onRestoreMonitoring}:{bookmarks:Bookmark[];exclusions:MonitorExclusion[];matches:Record<string,LiveMatch>;message:string;onRemove:(id:string)=>Promise<void>;onRestoreMonitoring:(id:string)=>Promise<void>}) {
  const excludedIds=new Set(exclusions.map(row=>row.fixtureId));
  return <section className="bookmark-panel"><div className="bookmark-heading"><div><span>BOOKMARKS</span><strong>{bookmarks.length}</strong></div><small>{message||'kickoff 3分前から自動Socket監視'}</small></div><div className="bookmark-list">{bookmarks.length?bookmarks.map(b=><article key={b.fixtureId}><div><b>{b.home} vs {b.away}</b><small>{b.country} · {b.league}</small></div><time>{new Date(b.kickoffUtc).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'})}</time><span className={`bookmark-status ${excludedIds.has(b.fixtureId)?'excluded':b.status}`}>{excludedIds.has(b.fixtureId)?'監視除外中':matches[b.fixtureId]?.subscriptionState??b.status}</span>{b.relatedTeamName&&<em>好調: {b.relatedTeamName}</em>}{excludedIds.has(b.fixtureId)&&<button onClick={()=>void onRestoreMonitoring(b.fixtureId)}>監視に戻す</button>}<button onClick={()=>void onRemove(b.fixtureId)}>Bookmarkを外す</button></article>):<p>Bookmarkはまだありません</p>}</div>{exclusions.length>0&&<div className="monitor-exclusion-list"><span>監視除外リスト（Mac復帰・再読込後も維持）</span>{exclusions.map(row=><button key={row.fixtureId} onClick={()=>void onRestoreMonitoring(row.fixtureId)}>{row.home||row.fixtureId} {row.away?`vs ${row.away}`:''} · 監視に戻す</button>)}</div>}</section>;
}

function isSelectedLeague(fixture: UpcomingFixture) {
  const country = normalize(fixture.country);
  const league = normalize(fixture.league).replace(/\s+-\s+.*$/, '');
  const exact: Record<string, string[]> = {
    england: ['premier league', 'championship', 'league one', 'league two', 'efl league one', 'efl league two'],
    spain: ['la liga', 'laliga', 'primera division', 'segunda division', 'la liga 2', 'laliga2', 'primera federacion', 'primera rfef', 'primera division rfef'],
    italy: ['serie a', 'serie b', 'coppa italia'],
    germany: ['bundesliga', '2. bundesliga'],
    france: ['ligue 1', 'ligue 2'],
    iran: ['persian gulf pro league', 'pro league'],
    'saudi arabia': ['saudi league', 'pro league', 'saudi pro league', 'first division', 'division 1', '1st division', 'first league', 'yelo league'],
    bulgaria: ['first league'],
    austria: ['bundesliga'],
    denmark: ['superliga', '1st division', '1. division', 'division 1'],
    belgium: ['first division a', 'pro league'],
    switzerland: ['super league'],
    scotland: ['premiership'],
    turkey: ['1. lig', '1 lig'],
    turkiye: ['1. lig', '1 lig'],
    qatar: ['stars league', 'qatar stars league'],
    algeria: ['ligue 1'],
    poland: ['ekstraklasa', 'i liga', '1. liga', 'liga i'],
    estonia: ['esiliiga a'],
    armenia: ['premier league'],
    egypt: ['premier league'],
    hungary: ['nb i', 'nb 1'],
    netherlands: ['eredivisie', 'eerste divisie'],
    ecuador: ['liga pro', 'serie a', 'primera a'],
    brazil: ['serie a', 'serie b', 'brasileirao serie a', 'brasileirao serie b'],
    argentina: ['liga profesional', 'primera division'],
    colombia: ['primera a', 'liga betplay'],
    japan: ['j1 league', 'j league 1', 'j. league 1', 'j2 league', 'j league 2', 'j. league 2'],
    'south korea': ['k league 1', 'k league 2'],
    korea: ['k league 1', 'k league 2'],
    'korea republic': ['k league 1', 'k league 2'],
    thailand: ['thai league 1', 'league 1'],
    indonesia: ['liga 1', 'league 1'],
    norway: ['1st division', '1. division', 'division 1', 'obos-ligaen', 'obos ligaen'],
    sweden: ['superettan'],
  };
  // UEFA competitions can be returned as Europe/World depending on the
  // provider feed, so they are intentionally league-name based.
  const uefaCompetitions = [
    'uefa champions league', 'champions league',
    'uefa europa league', 'europa league',
    'uefa europa conference league', 'europa conference league', 'conference league',
  ];
  return (exact[country] ?? []).includes(league) || uefaCompetitions.includes(league);
}

function normalize(value: string) { return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase(); }

function MatchCard({ match, onCapture, onSelectSnapshot, onRemove, onRefresh }: { match: LiveMatch; onCapture: () => void; onSelectSnapshot: (id: string) => void; onRemove: () => void; onRefresh: () => void }) {
  const status = displayMatchMinute(match.status);
  const selectedSnapshot = match.snapshots.find((snapshot) => snapshot.id === match.selectedSnapshotId);
  const lastReceivedMs = Date.parse(match.lastReceivedAt ?? '');
  const stale = !match.ended && Number.isFinite(lastReceivedMs) && Date.now() - lastReceivedMs >= 90_000;
  const waitingForProvider = !match.ended && !match.updates && !match.stats.length && match.subscriptionState === 'subscribed_waiting';
  const subscribedMs = Date.parse(match.subscribedAt ?? '');
  const providerSilent = waitingForProvider && Number.isFinite(subscribedMs) && Date.now() - subscribedMs >= 15_000;
  return <article className="score-card"><div className="league-line"><span>{match.country} · {match.league}</span><span className="fixture-controls"><b>{status}</b>{!match.ended && <button className="refresh-fixture" onClick={onRefresh}>再subscribe</button>}<button onClick={onRemove}>{match.ended ? '一覧から外す' : '監視から外す'}</button></span></div><div className="scoreline"><div><span className="crest home">{match.home.slice(0, 2).toUpperCase()}</span><strong>{match.home}</strong></div><p><b>{match.homeScore}</b><i>–</i><b>{match.awayScore}</b></p><div><span className="crest away">{match.away.slice(0, 2).toUpperCase()}</span><strong>{match.away}</strong></div></div><div className={`update-line ${stale ? 'stale' : ''}`}><span className="live-pill">● {match.ended ? 'FINISHED' : stale ? 'UPDATE STALE' : waitingForProvider ? 'SUBSCRIBED' : 'LIVE'}</span><span>{match.updatedAt ? `Socket更新 ${match.updatedAt} JST · #${match.updates}${stale ? ' · provider更新停止を検知' : ''}` : waitingForProvider ? 'subscribe成功・最初のSocket更新（分数・stats）待ち' : 'subscribe応答待ち'}</span></div>
    {match.htStats && <DeltaPanel match={match} />}
    <div className="snapshot-panel"><div className="snapshot-actions"><button onClick={onCapture} disabled={!match.stats.length}>現在値をスナップ（REST 0）</button><span>{match.snapshots.length ? `${match.snapshots.length}件保存` : '好きな時点を保存できます'}</span></div>{match.snapshots.length > 0 && <div className="snapshot-tabs">{match.snapshots.map((snapshot) => <button className={snapshot.id === match.selectedSnapshotId ? 'active' : ''} onClick={() => onSelectSnapshot(snapshot.id)} key={snapshot.id}>{formatSnapshotStatus(snapshot.status)} <small>{snapshot.capturedAt}</small></button>)}</div>}</div>
    {selectedSnapshot && <SnapshotDeltaPanel match={match} snapshot={selectedSnapshot} />}
    {match.stats.length ? <div className="stats"><div className="stat-head"><span>HOME</span><b>CURRENT STATISTICS</b><span>AWAY</span></div>{match.stats.map((s, i) => { const unavailable = isGoalProviderPlaceholderZeroPair(s.type, s.home, s.away, match.status); return <div className="stat-row" key={`${s.type}-${i}`}><strong>{unavailable ? '—' : s.home ?? 'N/A'}</strong><span>{s.type}{unavailable ? '（GOAL API未提供）' : ''}</span><strong>{unavailable ? '—' : s.away ?? 'N/A'}</strong></div>; })}</div> : providerSilent ? <div className="waiting"><p>Socket接続・subscribeは成功しましたが、GOAL APIからmatch_updateが届いていません。分数とstatsはprovider未配信です。</p></div> : <div className="waiting"><span /><p>WebSocketの最初のmatch_updateを待っています</p></div>}
  </article>;
}

function DeltaPanel({ match }: { match: LiveMatch }) {
  const target = match.sixtyStats ?? match.stats;
  const rows = statDeltas(match.htStats ?? [], target, 'HT', match.sixtyStats ? String(match.sixtyMinute) : match.status);
  const currentMinute = /^\d+$/.test(match.status) ? Number(match.status) : null;
  const title = match.sixtyStats ? `HT → ${match.sixtyMinute}分 SNAPSHOT` : `HT → ${currentMinute ?? match.status} LIVE DELTA`;
  return <div className={`delta-panel ${match.sixtyStats ? 'locked' : ''}`}><div className="delta-title"><b>{title}</b><span>{match.sixtyStats ? '固定済み' : '60分到達待ち'}</span></div><div className="stat-head"><span>HOME ±</span><b>CHANGE</b><span>AWAY ±</span></div>{rows.map((row, index) => <div className="stat-row delta-row" key={`${row.type}-${index}`}><strong>{signed(row.home)}</strong><span>{row.type}</span><strong>{signed(row.away)}</strong></div>)}</div>;
}

function SnapshotDeltaPanel({ match, snapshot }: { match: LiveMatch; snapshot: ManualSnapshot }) {
  const rows = statDeltas(snapshot.stats, match.stats, snapshot.status, match.status);
  return <div className="snapshot-delta"><div className="delta-title"><b>{formatSnapshotStatus(snapshot.status)} → {formatSnapshotStatus(match.status)} CURRENT DELTA</b><span>取得 {snapshot.capturedAt} JST</span></div><div className="stat-head"><span>HOME ±</span><b>CHANGE</b><span>AWAY ±</span></div>{rows.length ? rows.map((row) => <div className="stat-row delta-row" key={row.key}><strong>{signed(row.home)}</strong><span>{row.type}</span><strong>{signed(row.away)}</strong></div>) : <p className="no-delta">比較可能な数値statsを待っています</p>}</div>;
}

function statDeltas(baseline: Stat[], target: Stat[], baselineStatus: string, targetStatus: string) {
  const occurrences = new Map<string, number>();
  return target.flatMap((stat) => {
    const occurrence = occurrences.get(stat.type) ?? 0;
    occurrences.set(stat.type, occurrence + 1);
    const before = baseline.filter((item) => item.type === stat.type)[occurrence];
    if (!before) return [];
    if (isGoalProviderPlaceholderZeroPair(stat.type, stat.home, stat.away, targetStatus) || isGoalProviderPlaceholderZeroPair(before.type, before.home, before.away, baselineStatus)) return [];
    const home = numeric(stat.home), away = numeric(stat.away), baseHome = numeric(before.home), baseAway = numeric(before.away);
    if (home === null || away === null || baseHome === null || baseAway === null) return [];
    return [{ key: `${stat.type}-${occurrence}`, type: occurrence ? `${stat.type} #${occurrence + 1}` : stat.type, home: home - baseHome, away: away - baseAway }];
  });
}

function formatSnapshotStatus(status: string) { return displayMatchMinute(status); }

function eventFromMatch(sessionId: string, match: LiveMatch, eventType: string, payload: unknown, receivedAt = new Date().toISOString()): MonitorEvent {
  return { sessionId, fixtureId: match.id, eventType, receivedAt, status: match.status, home: match.home, away: match.away, homeScore: match.homeScore, awayScore: match.awayScore, payload };
}

function persistEvents(events: MonitorEvent[]) {
  if (!events.length) return;
  void fetch('/api/monitor-events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ events }), keepalive: true }).catch(() => undefined);
}

function numeric(value: string | number | null) { const found = String(value ?? '').match(/-?\d+(?:\.\d+)?/); return found ? Number(found[0]) : null; }
function signed(value: number) { return value > 0 ? `+${value}` : String(value); }
