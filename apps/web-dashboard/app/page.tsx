'use client';

import './bookmarks.css';

import { useEffect, useMemo, useRef, useState } from 'react';
import { visibleCollectorFixtures, withoutFixture } from '@/lib/live-monitor-state';
import { displayMatchMinute } from '@/lib/live-minute';
import { readJsonResponse, responseFailureMessage } from '@/lib/safe-json-response';
import { isGoalProviderPlaceholderZeroPair } from '@/lib/live-stat-availability';
import { MAX_FORM_ANALYSIS_TEAMS } from '@/lib/form-analysis-batching';
import { formQualifiedFixtureIds, qualifiedUnbookmarkedFixtures } from '@/lib/form-bookmark-selection';
import { groupFormCandidates } from '@/lib/form-history-grouping';

type Fixture = { id: string; league: string; country: string; home: string; away: string; homeScore: string; awayScore: string; status: string; kickoffUtc?: string };
type UpcomingFixture = { id: string; league: string; leagueId?: string; country: string; home: string; away: string; homeTeamId: string; awayTeamId: string; kickoffUtc: string; kickoffJst: string; status: string };
type FormCandidate = { kickoffUtc: string; kickoffJst: string; league: string; country: string; fixtureId: string; home:string; away:string; homeTeamId:string; awayTeamId:string; teamId:string; team: string; side: 'home' | 'away'; opponent: string; wins: number; draws: number; last5: { result: string; score: string; opponent: string; fixtureId: string }[] };
type Stat = { type: string; home: string | number | null; away: string | number | null };
type ManualSnapshot = { id: string; status: string; capturedAt: string; stats: Stat[] };
type LiveMatch = Fixture & { stats: Stat[]; updatedAt?: string; lastReceivedAt?: string; updates: number; ended?: boolean; htStats?: Stat[] | null; daCutoffStats?: Stat[] | null; daCutoffMinute?: number | null; koCutoffStats?: Stat[] | null; koCutoffMinute?: number | null; minute65Stats?: Stat[] | null; minute65?: number | null; minute70Stats?: Stat[] | null; minute70?: number | null; minute75Stats?: Stat[] | null; minute75?: number | null; minute80Stats?: Stat[] | null; minute80?: number | null; historyFallback?: boolean; subscriptionState?: string; subscribedAt?: string | null; initialUpdateResubscribeAttempts?: number; snapshots: ManualSnapshot[]; selectedSnapshotId?: string };
type LiveSignal = { id:string; fixtureId:string; ruleId:string; ruleVersion:string; signalSide:string|null; triggeredAt:string; detectedMinute:number|null; feature?:Record<string,unknown>|null };
type SavedForm = { runId:string; createdAt:string; home: FormResult[] | null; away: FormResult[] | null };
type FormResult = { result:string; score:string; opponent:string; fixtureId:string };
type MonitorEvent = { sessionId: string; fixtureId: string; eventType: string; receivedAt: string; status?: string; home?: string; away?: string; homeScore?: string; awayScore?: string; payload: unknown };
type Bookmark = { fixtureId:string;home:string;away:string;league:string;country:string;kickoffUtc:string;reason:string;relatedTeamName?:string|null;status:'waiting'|'monitoring'|'finished'|'removed';updatedAt:string };
type MonitorExclusion = { fixtureId:string;home:string;away:string;reason:string;excludedAt:string;updatedAt:string };

function checkpointFallback(match: LiveMatch, history: Partial<LiveMatch>): LiveMatch {
  // The current socket frame remains authoritative for current score, status,
  // and statistics. Persisted history only fills the four display checkpoints
  // that an already-running older Collector cannot expose in its memory.
  if (!match.stats.length) return { ...match, ...history, snapshots: match.snapshots, selectedSnapshotId: match.selectedSnapshotId } as LiveMatch;
  // A history response deliberately includes null for a target that has not
  // happened yet. Prefer that explicit null over an old Collector's early
  // in-memory candidate (for example, 46' being incorrectly shown as 70').
  const hasHistory = (key: keyof LiveMatch) => Object.prototype.hasOwnProperty.call(history, key);
  const checkpoint = (statsKey: keyof LiveMatch, minuteKey: keyof LiveMatch, currentStats: Stat[] | null, currentMinute: number | null): [Stat[] | null, number | null] => hasHistory(statsKey)
    ? [history[statsKey] as Stat[] | null, history[minuteKey] as number | null]
    : [currentStats, currentMinute];
  const [minute65Stats, minute65] = checkpoint('minute65Stats', 'minute65', match.minute65Stats ?? null, match.minute65 ?? null);
  const [minute70Stats, minute70] = checkpoint('minute70Stats', 'minute70', match.minute70Stats ?? null, match.minute70 ?? null);
  const [minute75Stats, minute75] = checkpoint('minute75Stats', 'minute75', match.minute75Stats ?? null, match.minute75 ?? null);
  const [minute80Stats, minute80] = checkpoint('minute80Stats', 'minute80', match.minute80Stats ?? null, match.minute80 ?? null);
  return {
    ...match,
    minute65Stats, minute65,
    minute70Stats, minute70,
    minute75Stats, minute75,
    minute80Stats, minute80,
  };
}

export default function Home() {
  const [viewMode, setViewMode] = useState<'live' | 'upcoming' | 'manage'>('live');
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
  const [applyingSavedAuto, setApplyingSavedAuto] = useState(false);
  const [liveSignals, setLiveSignals] = useState<Record<string, LiveSignal[]>>({});
  const [liveForms, setLiveForms] = useState<Record<string, SavedForm>>({});
  const sessionIdRef = useRef('');
  const matchesRef = useRef<Record<string, LiveMatch>>({});
  const hiddenFixtureIdsRef = useRef(new Set<string>());
  const excludedFixtureIdsRef = useRef(new Set<string>());
  const lastSignalPollAtRef = useRef(0);
  const visible = useMemo(() => fixtures.filter((f) => `${f.home} ${f.away} ${f.league} ${f.country}`.toLowerCase().includes(query.toLowerCase())), [fixtures, query]);
  const additionalIds = selected.filter((id) => !matches[id] && !monitorExclusions.some((row) => row.fixtureId === id));
  const availableSlots = Math.max(0, 25 - Object.keys(matches).length);
  const addableIds = additionalIds.slice(0, availableSlots);

  async function loadBookmarks() { try { const response=await fetch('/api/bookmarks',{cache:'no-store'}); if(response.ok)setBookmarks((await response.json()).bookmarks??[]); } catch {} }
  async function loadMonitorExclusions() { try { const response=await fetch('/api/monitor-exclusions',{cache:'no-store'}); if(response.ok){const rows=(await response.json()).exclusions??[];excludedFixtureIdsRef.current=new Set(rows.map((row:MonitorExclusion)=>String(row.fixtureId)));setMonitorExclusions(rows);} } catch {} }
  async function bookmarkFixture(fixture: { id:string;home:string;away:string;league:string;country:string;kickoffUtc?:string;leagueId?:string;homeTeamId?:string;awayTeamId?:string }, reason='manual', relatedTeamId?:string, relatedTeamName?:string) {
    try { const response=await fetch('/api/bookmarks',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({fixtureId:fixture.id,home:fixture.home,away:fixture.away,league:fixture.league,country:fixture.country,kickoffUtc:fixture.kickoffUtc??new Date().toISOString(),leagueId:fixture.leagueId,homeTeamId:fixture.homeTeamId,awayTeamId:fixture.awayTeamId,reason,relatedTeamId,relatedTeamName})}); const data=await response.json(); if(!response.ok)throw new Error(data.error);const identityNote=data.identity?.status==='CREATED'?' · typed identity保存済み':data.identity?.status==='EXISTING'?' · typed identity既存':data.identity?.status?' · typed identity保留':'';setBookmarkMessage(`${fixture.home} vs ${fixture.away}をBookmarkしました${identityNote}`);await loadBookmarks(); }
    catch(error){setBookmarkMessage(error instanceof Error?error.message:'Bookmark失敗')}
  }
  async function removeBookmark(fixtureId:string){await fetch(`/api/bookmarks?fixtureId=${encodeURIComponent(fixtureId)}`,{method:'DELETE'});await loadBookmarks()}
  async function bookmarkFixtures(items: UpcomingFixture[]) {
    const unique=[...new Map(items.map((item)=>[item.id,item])).values()].filter((item)=>!bookmarks.some((bookmark)=>bookmark.fixtureId===item.id));
    if (!unique.length) { setBookmarkMessage('選択した試合はすでにすべてBookmark済みです。'); return; }
    let saved=0; const failed:string[]=[];
    for (const fixture of unique) {
      try {
        const response=await fetch('/api/bookmarks',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({fixtureId:fixture.id,home:fixture.home,away:fixture.away,league:fixture.league,country:fixture.country,kickoffUtc:fixture.kickoffUtc,leagueId:fixture.leagueId,homeTeamId:fixture.homeTeamId,awayTeamId:fixture.awayTeamId,reason:'upcoming-bulk'})});
        if (!response.ok && response.status!==409) throw new Error((await response.json().catch(()=>({}))).error||'Bookmark失敗');
        saved += 1;
      } catch { failed.push(`${fixture.home} vs ${fixture.away}`); }
    }
    await loadBookmarks(); setBookmarkMessage(`選択した${unique.length}試合を一括Bookmark: 保存 ${saved} / 失敗 ${failed.length}${failed.length?`（${failed.slice(0,3).join(' / ')}${failed.length>3?' ほか':''}）`:''}`);
  }
  async function excludeBookmarksFromMonitoring(items: Bookmark[]) {
    const unique=[...new Map(items.map((item)=>[item.fixtureId,item])).values()].filter((item)=>!excludedFixtureIdsRef.current.has(item.fixtureId));
    if (!unique.length) { setMessage('選択した試合はすでにLIVE画面から外れています。'); return; }
    let saved=0; const failed:string[]=[];
    for (const bookmark of unique) {
      try {
        const exclusion=await fetch('/api/monitor-exclusions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({fixtureId:bookmark.fixtureId,home:bookmark.home,away:bookmark.away,reason:'bulk_manual_monitor_exclusion'})});
        if (!exclusion.ok) throw new Error('監視除外の保存に失敗しました');
        excludedFixtureIdsRef.current.add(bookmark.fixtureId); hiddenFixtureIdsRef.current.add(bookmark.fixtureId);
        const match=matchesRef.current[bookmark.fixtureId];
        if (match && !match.ended) {
          const response=await fetch('/api/collector',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'remove',fixtureId:bookmark.fixtureId,reason:'bulk_manual_monitor_exclusion'})});
          if (!response.ok) throw new Error('Collectorから外せませんでした');
          setMatches((now)=>withoutFixture(now,bookmark.fixtureId));
        }
        saved += 1;
      } catch { failed.push(`${bookmark.home} vs ${bookmark.away}`); }
    }
    await loadMonitorExclusions(); setMessage(`選択した${unique.length}試合をLIVE画面から外しました。Bookmarkは維持: 成功 ${saved} / 失敗 ${failed.length}${failed.length?`（${failed.slice(0,3).join(' / ')}${failed.length>3?' ほか':''}）`:''}`);
  }
  async function restoreMonitoring(fixtureId:string){const response=await fetch(`/api/monitor-exclusions?fixtureId=${encodeURIComponent(fixtureId)}`,{method:'DELETE'});if(response.ok){excludedFixtureIdsRef.current.delete(fixtureId);hiddenFixtureIdsRef.current.delete(fixtureId);await loadMonitorExclusions();setMessage('監視除外を解除しました。Bookmark済みならschedulerが再び監視へ追加します。');}}
  async function applySavedAutoBookmarks() {
    if (applyingSavedAuto) return;
    setApplyingSavedAuto(true);
    try {
      const response = await fetch('/api/form-candidates', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ action:'auto_bookmark_saved' }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'AUTO監視への反映に失敗しました');
      const auto=data.autoForm ?? {};
      setBookmarkMessage(`保存済み調子分析をAUTO監視へ反映しました（REST 0）。対象 ${auto.eligible ?? 0} / 新規Bookmark ${auto.bookmarked ?? 0} / 既存 ${auto.existing ?? 0} / conflict ${auto.conflicts ?? 0}。`);
      await loadBookmarks();
    } catch (error) { setBookmarkMessage(error instanceof Error ? error.message : 'AUTO監視への反映に失敗しました'); }
    finally { setApplyingSavedAuto(false); }
  }

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
  useEffect(() => {
    const fixtureIds = Object.keys(matches).sort(); if (!fixtureIds.length) return;
    let cancelled = false;
    const hydrateCheckpoints = () => {
      void fetch(`/api/live-card-history?fixtureIds=${encodeURIComponent(fixtureIds.join(','))}`, { cache: 'no-store' })
        .then(async (response) => response.ok ? response.json() : { fixtures: {} })
        .then((data) => {
          if (cancelled) return;
          const saved = data.fixtures as Record<string, Partial<LiveMatch>>;
          setMatches((current) => Object.fromEntries(Object.entries(current).map(([fixtureId, match]) => {
            const history = saved[fixtureId]; return [fixtureId, history ? checkpointFallback(match, history) : match];
          })));
        }).catch(() => undefined);
    };
    hydrateCheckpoints(); const timer=window.setInterval(hydrateCheckpoints,5_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [Object.keys(matches).sort().join(',')]);
  useEffect(() => {
    const fixtureIds = Object.keys(matches);
    if (!fixtureIds.length) { setLiveForms({}); return; }
    let cancelled = false;
    void fetch(`/api/live-form?fixtureIds=${encodeURIComponent(fixtureIds.join(','))}`, { cache: 'no-store' })
      .then(async (response) => response.ok ? response.json() : { forms: {} })
      .then((data) => { if (!cancelled) setLiveForms(data.forms ?? {}); })
      .catch(() => { if (!cancelled) setLiveForms({}); });
    return () => { cancelled = true; };
  }, [Object.keys(matches).sort().join(',')]);
  useEffect(() => { void loadBookmarks(); void loadMonitorExclusions(); const timer=window.setInterval(()=>{void loadBookmarks();void loadMonitorExclusions();},5000); return()=>window.clearInterval(timer); }, []);
  useEffect(() => {
    let cancelled = false;
    const sync = async () => {
      try {
        const response = await fetch('/api/collector', { cache: 'no-store' }); if (!response.ok) throw new Error();
        const data = await response.json(); if (cancelled) return;
        sessionIdRef.current = data.sessionId ?? ''; setCollectorRequests(Number(data.goalApiRequests ?? 0));
        setFrameCount((data.fixtures ?? []).reduce((sum: number, fixture: LiveMatch) => sum + Number(fixture.updates ?? 0), 0));
        if (data.fixtures?.length) { const hidden=new Set([...hiddenFixtureIdsRef.current,...excludedFixtureIdsRef.current]); setMatches((current) => Object.fromEntries(visibleCollectorFixtures(data.fixtures as LiveMatch[], hidden).map((fixture) => { const prior=current[fixture.id]; const saved=(!fixture.stats?.length&&prior?.historyFallback)?prior:null; const currentFixture={ ...fixture, ...(saved ? { status:saved.status,stats:saved.stats,updatedAt:saved.updatedAt,lastReceivedAt:saved.lastReceivedAt,updates:saved.updates,ended:saved.ended,htStats:saved.htStats,daCutoffStats:saved.daCutoffStats,daCutoffMinute:saved.daCutoffMinute,koCutoffStats:saved.koCutoffStats,koCutoffMinute:saved.koCutoffMinute,historyFallback:true } : { updatedAt: fixture.updatedAt ? new Date(fixture.updatedAt).toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo' }) : undefined }), snapshots: prior?.snapshots ?? [], selectedSnapshotId: prior?.selectedSnapshotId } as LiveMatch; return [fixture.id, prior ? checkpointFallback(currentFixture, prior) : currentFixture]; }))); }
        if (data.fixtures?.length && data.sessionId && Date.now() - lastSignalPollAtRef.current >= 5_000) { lastSignalPollAtRef.current=Date.now(); const fixtureIds=encodeURIComponent((data.fixtures as LiveMatch[]).map((fixture)=>fixture.id).join(',')); const sessionId=encodeURIComponent(String(data.sessionId)); void fetch(`/api/live-signals?fixtureIds=${fixtureIds}&sessionId=${sessionId}`,{cache:'no-store'}).then(async(response)=>{if(!response.ok)return;const signalBody=await response.json();if(cancelled)return;const grouped:Record<string,LiveSignal[]>={};for(const signal of signalBody.signals??[])(grouped[signal.providerFixtureId]??=[]).push(signal);setLiveSignals(grouped);}).catch(()=>undefined); }
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
      <a className="odds-nav" href="/live-history">LIVE履歴</a>
      <div className="health"><span className={`dot ${connection}`} />{connection === 'live' ? 'SOCKET CONNECTED' : connection === 'connecting' ? 'CONNECTING' : connection === 'error' ? 'CONNECTION ERROR' : 'SOCKET OFF'}</div>
      <div className="quota"><span>HTTP USED</span><strong>{restCount + collectorRequests}</strong><small>WS updates {frameCount}</small></div>
    </header>
    <nav className="view-tabs" aria-label="表示切替"><button className={viewMode === 'live' ? 'active' : ''} onClick={() => setViewMode('live')}>LIVE監視</button><button className={viewMode === 'upcoming' ? 'active' : ''} onClick={() => setViewMode('upcoming')}>24時間分析</button><a className="view-tab-link" href="/live-history">LIVE履歴</a><button className={viewMode === 'manage' ? 'active' : ''} onClick={() => setViewMode('manage')}>管理</button></nav>
    {viewMode !== 'manage' && <section className="commandbar"><div><h1>{viewMode === 'live' ? 'ライブ試合を選んで、リアルタイムで見る。' : 'これから24時間以内に始まる全試合。'}</h1><p>{viewMode === 'live' ? message : upcomingMessage}</p></div><div className="actions">
      {viewMode === 'live' ? <><button className="secondary" onClick={loadFixtures} disabled={loading}>{loading ? '取得中…' : fixtures.length ? '一覧を更新' : 'ライブ試合を取得'}</button>
      {connection === 'live' ? <><button className="primary" onClick={addSelectedMatches} disabled={!addableIds.length || !availableSlots}>選択から{addableIds.length}試合を追加</button><button className="danger" onClick={stopMonitoring}>監視を停止</button></> : connection === 'connecting' ? <button className="danger" onClick={stopMonitoring}>接続を中止</button> : <button className="primary" onClick={startMonitoring} disabled={!selected.length}>選択した{selected.length}試合を監視</button>}</> : <button className="primary" onClick={loadUpcomingFixtures} disabled={upcomingLoading}>{upcomingLoading ? '取得中…' : upcomingFixtures.length ? '24時間一覧を更新' : '今後24時間を取得'}</button>}
    </div></section>}
    {viewMode === 'live' ? <div className="workspace">
      <aside className="match-picker"><div className="picker-head"><div><span className="eyebrow">LIVE MATCHES</span><strong>{fixtures.length}</strong></div><span className="selection-count">{selected.length}/25 選択</span></div>
        <input aria-label="試合検索" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="チーム・リーグを検索" />
        <div className="fixture-list">{!fixtures.length && <div className="empty"><span>◉</span><p>まだ一覧を取得していません</p><small>LIVE/HTを各1ページ取得。100件超は次ページ分を追加します</small></div>}
          {visible.map((f) => <div key={f.id} className={`fixture ${selected.includes(f.id) ? 'chosen' : ''}`}><input aria-label={`${f.home} vs ${f.away}を選択`} type="checkbox" checked={selected.includes(f.id)} onChange={() => toggle(f.id)} /><div className="fixture-main"><small>{f.country} · {f.league}</small><div><span>{f.home}</span><b>{f.homeScore}</b></div><div><span>{f.away}</span><b>{f.awayScore}</b></div></div><span className="minute">{displayMatchMinute(f.status)}<button className="bookmark-mini" disabled={bookmarks.some(b=>b.fixtureId===f.id)} onClick={()=>void bookmarkFixture(f,'live-manual')}>★</button></span></div>)}
        </div>
      </aside>
      <section className="score-stage">{!Object.keys(matches).length && <div className="hero-empty"><div className="pulse-rings"><span /><span /><b>⚽</b></div><h2>試合を選択してください</h2><p>左のライブ一覧から最大25試合を選び、1本のSocketで同時監視できます。</p><div className="flow"><span>LIVE LIST<small>通常2 REST</small></span><i>→</i><span>SELECT<small>最大25試合</small></span><i>→</i><span>WEBSOCKET<small>更新消費 0</small></span></div></div>}
        <div className="cards-grid">{Object.values(matches).map((m) => <MatchCard key={m.id} match={m} form={liveForms[m.id] ?? null} signals={liveSignals[m.id]??[]} onCapture={() => captureSnapshot(m.id)} onSelectSnapshot={(snapshotId) => selectSnapshot(m.id, snapshotId)} onRemove={() => m.ended ? void hideFinishedFixture(m.id) : void removeFromMonitoring(m.id)} onRefresh={() => void refreshSubscription(m.id)} />)}</div>
      </section>
    </div> : viewMode === 'upcoming' ? <UpcomingBoard fixtures={upcomingFixtures} loading={upcomingLoading} onRest={(count) => setRestCount((value) => value + count)} bookmarks={bookmarks} onBookmark={bookmarkFixture} onBulkBookmark={bookmarkFixtures} /> : <ManagementBoard bookmarks={bookmarks} exclusions={monitorExclusions} matches={matches} message={bookmarkMessage} onRemove={removeBookmark} onRestoreMonitoring={restoreMonitoring} onBulkExclude={excludeBookmarksFromMonitoring} onApplySavedAuto={applySavedAutoBookmarks} applyingSavedAuto={applyingSavedAuto} />}
  </main>;
}

function UpcomingBoard({ fixtures, loading, onRest, bookmarks, onBookmark, onBulkBookmark }: { fixtures: UpcomingFixture[]; loading: boolean; onRest: (count: number) => void; bookmarks:Bookmark[]; onBookmark:(fixture:UpcomingFixture,reason?:string,relatedTeamId?:string,relatedTeamName?:string)=>Promise<void>; onBulkBookmark:(fixtures:UpcomingFixture[])=>Promise<void> }) {
  const [scope, setScope] = useState<'all' | 'big5'>('big5');
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisMessage, setAnalysisMessage] = useState('');
  const [candidates, setCandidates] = useState<FormCandidate[]>([]);
  const [formRunId, setFormRunId] = useState('');
  const [oddsLoading, setOddsLoading] = useState(false);
  const [oddsMessage, setOddsMessage] = useState('');
  const [selectedFixtureIds, setSelectedFixtureIds] = useState<string[]>([]);
  const shown = scope === 'big5' ? fixtures.filter(isSelectedLeague) : fixtures;
  const uniqueTeams = new Set(shown.flatMap((fixture) => [fixture.homeTeamId, fixture.awayTeamId]).filter(Boolean)).size;
  const qualifiedFixtureIds=formQualifiedFixtureIds(candidates);
  const bookmarkable=qualifiedUnbookmarkedFixtures(shown,candidates,bookmarks);
  const selectedFixtures=bookmarkable.filter((fixture)=>selectedFixtureIds.includes(fixture.id));
  const allBookmarkableSelected=bookmarkable.length>0&&selectedFixtures.length===bookmarkable.length;
  function toggleBookmarkSelection(id:string) { if (!qualifiedFixtureIds.has(id)) return; setSelectedFixtureIds((now)=>now.includes(id)?now.filter((value)=>value!==id):[...now,id]); }
  function toggleAllBookmarkable() { setSelectedFixtureIds(allBookmarkableSelected?[]:bookmarkable.map((fixture)=>fixture.id)); }

  async function analyzeForm() {
    if (!shown.length || analyzing) return;
    setAnalyzing(true); setCandidates([]); setAnalysisMessage(`${uniqueTeams}チームの直近5試合を確認中…`);
    try {
      const response = await fetch('/api/form-candidates', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fixtures: shown }) });
      const data = await response.json();
      onRest(Number(data.apiRequests ?? 0));
      if (!response.ok) throw new Error(data.error || '直近成績を取得できませんでした');
      setCandidates(data.candidates ?? []);
      setSelectedFixtureIds([]);
      setFormRunId(data.runId ?? '');
      setOddsMessage('');
      const outcomes = Object.entries(data.outcomeCounts ?? {}).map(([name, count]) => `${name} ${count}`).join(' / ');
      const typed=data.typed;const typedMessage=typed?` typed form: 保存 ${typed.saved ?? 0} / 既存 ${typed.existing ?? 0} / 保留 ${typed.skipped ?? 0} / error ${typed.error ?? 0}。`:'';
      const auto=data.autoForm;const autoMessage=auto?` AUTO監視: allowlist ${auto.eligible ?? 0} / identity作成 ${auto.created ?? 0} / 既存 ${auto.existing ?? 0} / Bookmark登録 ${auto.bookmarked ?? 0} / conflict ${auto.conflicts ?? 0} / 保留 ${Object.values(auto.skipped ?? {}).reduce((sum:any,value:any)=>Number(sum)+Number(value),0)}。`:'';
      setAnalysisMessage(`${data.checkedTeams}チームを${data.apiRequests} RESTで確認（retry ${data.retryCount ?? 0}）。最終候補は${data.candidates.length}チーム（直近2戦 LL / DL / LD により${data.excludedCount ?? 0}チーム除外）${data.failedTeams ? `（取得失敗 ${data.failedTeams}）` : ''}。${outcomes ? `内訳: ${outcomes}。` : ''}${data.saved ? '分析結果を履歴保存しました。' : '結果の保存だけ失敗しました。'}${typedMessage}${autoMessage}`);
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
      <div className="scope-panel"><div><button className={scope === 'big5' ? 'active' : ''} onClick={() => { setScope('big5'); setCandidates([]); setAnalysisMessage(''); }}>指定リーグ</button><button className={scope === 'all' ? 'active' : ''} onClick={() => { setScope('all'); setCandidates([]); setAnalysisMessage(''); }}>全試合</button></div><div className="actions"><a className="secondary" href="/form-history">保存済み候補からオッズ取得</a><button className="analyze-button" disabled={analyzing || !shown.length || uniqueTeams > MAX_FORM_ANALYSIS_TEAMS} onClick={analyzeForm}>{analyzing ? '分析中…' : `直近5試合を分析（最大 ${uniqueTeams} REST）`}</button></div></div>
      <div className="scope-note">絞り込みは取得済みfixture内で行うため追加REST 0。直近成績はユニークteamごとに1 RESTです。</div>
      <div className="upcoming-summary"><span>{scope === 'big5' ? 'SELECTED LEAGUES' : 'UPCOMING FIXTURES'}</span><strong>{shown.length}</strong><small>現在時刻から24時間以内・JST順 · {uniqueTeams}チーム</small></div>
      <div className="bulk-actions"><label><input type="checkbox" checked={allBookmarkableSelected} onChange={toggleAllBookmarkable} disabled={!bookmarkable.length} /> 5試合Formで好調な未Bookmark試合をすべて選択</label><button disabled={!selectedFixtures.length} onClick={()=>void onBulkBookmark(selectedFixtures)}>★ 好調な{selectedFixtures.length}試合をBookmark</button><small>{candidates.length ? `Form合格fixture ${qualifiedFixtureIds.size} / 一括Bookmark可能 ${bookmarkable.length}` : '一括Bookmarkは、まず直近5試合の分析後に利用できます。'}</small></div>
      {analysisMessage && <div className="analysis-message">{analysisMessage}</div>}
      {candidates.length > 0 && <div className="odds-fetch-row"><button disabled={oddsLoading} onClick={fetchCandidateOdds}>{oddsLoading ? 'オッズ取得・保存中…' : `候補${new Set(candidates.map(c => c.fixtureId)).size}試合のオッズを取得・保存`}</button><a href="/odds">保存済みオッズを見る →</a></div>}
      {oddsMessage && <div className="analysis-message">{oddsMessage}</div>}
      {candidates.length > 0 && <section className="candidate-section"><div className="candidate-title"><span>WATCH CANDIDATES</span><strong>4勝以上 / 3勝＋1分以上 / 直近3連勝（直近2戦 LL / DL / LD は除外）</strong></div><div className="candidate-grid">{candidates.map((candidate) => {const fixture=fixtures.find(f=>f.id===candidate.fixtureId);return <article className="candidate-card" key={`${candidate.fixtureId}-${candidate.team}`}><div><time>{candidate.kickoffJst} JST</time><b>{candidate.wins}W {candidate.draws}D / 5</b></div><h3>{candidate.team}</h3><p>{candidate.side.toUpperCase()} vs {candidate.opponent}</p><small>{candidate.country} · {candidate.league}</small><div className="form-strip">{candidate.last5.map((result, index) => <span className={result.result.toLowerCase()} title={`${result.opponent} ${result.score}`} key={`${result.fixtureId}-${index}`}>{result.result}</span>)}</div>{fixture&&<button className="bookmark-button" disabled={bookmarks.some(b=>b.fixtureId===fixture.id)} onClick={()=>void onBookmark(fixture,'good-form',candidate.teamId,candidate.team)}>★ 好調候補をBookmark</button>}</article>})}</div></section>}
      <div className="upcoming-list">{shown.map((fixture) => <article className="upcoming-row" key={fixture.id}>
        <label className="bulk-choice"><input aria-label={`${fixture.home} vs ${fixture.away}を好調候補の一括Bookmark用に選択`} title={qualifiedFixtureIds.has(fixture.id) ? 'Form合格: 一括Bookmark対象' : 'Form未合格: 一括Bookmark対象外'} type="checkbox" disabled={bookmarks.some((bookmark)=>bookmark.fixtureId===fixture.id)||!qualifiedFixtureIds.has(fixture.id)} checked={selectedFixtureIds.includes(fixture.id)} onChange={()=>toggleBookmarkSelection(fixture.id)} /></label>
        <time dateTime={fixture.kickoffUtc}><strong>{fixture.kickoffJst}</strong><small>JST</small></time>
        <div className="upcoming-teams"><span>{fixture.home}</span><i>vs</i><span>{fixture.away}</span></div>
        <div className="upcoming-meta"><strong>{fixture.country}</strong><span>{fixture.league}</span><code>{fixture.id}</code><button className="bookmark-button" disabled={bookmarks.some(b=>b.fixtureId===fixture.id)} onClick={()=>void onBookmark(fixture,'upcoming-manual')}>★ Bookmark</button></div>
      </article>)}</div>
    </>}
  </section>;
}

function BookmarkPanel({bookmarks,exclusions,matches,message,onRemove,onRestoreMonitoring,onBulkExclude}:{bookmarks:Bookmark[];exclusions:MonitorExclusion[];matches:Record<string,LiveMatch>;message:string;onRemove:(id:string)=>Promise<void>;onRestoreMonitoring:(id:string)=>Promise<void>;onBulkExclude:(items:Bookmark[])=>Promise<void>}) {
  const excludedIds=new Set(exclusions.map(row=>row.fixtureId));
  const dates=useMemo(()=>[...new Set(bookmarks.map(bookmarkDate).filter(Boolean))].sort(),[bookmarks]);
  const [selectedDate,setSelectedDate]=useState('');
  const [layout,setLayout]=useState<'time'|'country'>('time');
  const [selectedIds,setSelectedIds]=useState<string[]>([]);
  const activeDate=dates.includes(selectedDate)?selectedDate:(dates.at(-1)??'');
  const visibleBookmarks=bookmarks.filter(bookmark=>bookmarkDate(bookmark)===activeDate).sort((a,b)=>Date.parse(a.kickoffUtc)-Date.parse(b.kickoffUtc));
  const countryGroups=useMemo(()=>groupFormCandidates(visibleBookmarks.map((bookmark)=>({...bookmark,team:`${bookmark.home} vs ${bookmark.away}`,kickoffUtc:bookmark.kickoffUtc}))),[visibleBookmarks]);
  const selectable=visibleBookmarks.filter((bookmark)=>!excludedIds.has(bookmark.fixtureId));
  const selected=selectable.filter((bookmark)=>selectedIds.includes(bookmark.fixtureId));
  const allSelected=selectable.length>0&&selected.length===selectable.length;
  function toggle(id:string) { setSelectedIds((now)=>now.includes(id)?now.filter((value)=>value!==id):[...now,id]); }
  function toggleAll() { setSelectedIds(allSelected?[]:selectable.map((bookmark)=>bookmark.fixtureId)); }
  async function excludeSelected() { await onBulkExclude(selected); setSelectedIds([]); }
  const card=(b:Bookmark)=><article key={b.fixtureId}><label className="bulk-choice"><input aria-label={`${b.home} vs ${b.away}を監視対象外にするため選択`} type="checkbox" disabled={excludedIds.has(b.fixtureId)} checked={selectedIds.includes(b.fixtureId)} onChange={()=>toggle(b.fixtureId)} /></label><div><b>{b.home} vs {b.away}</b><small>{b.country} · {b.league}</small></div><time>{new Date(b.kickoffUtc).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'})}</time><span className={`bookmark-status ${excludedIds.has(b.fixtureId)?'excluded':b.status}`}>{excludedIds.has(b.fixtureId)?'LIVE画面から非表示':matches[b.fixtureId]?.subscriptionState??b.status}</span>{b.relatedTeamName&&<em>好調: {b.relatedTeamName}</em>}{excludedIds.has(b.fixtureId)&&<button onClick={()=>void onRestoreMonitoring(b.fixtureId)}>LIVE画面へ戻す</button>}<button onClick={()=>void onRemove(b.fixtureId)}>Bookmarkを外す</button></article>;
  return <section className="bookmark-panel"><div className="bookmark-heading"><div><span>BOOKMARKS</span><strong>{bookmarks.length}</strong></div><small>{message||'kickoff 3分前から自動Socket監視'}</small></div>{dates.length>0&&<div className="bookmark-toolbar"><label className="bookmark-date-filter">表示日 <select value={activeDate} onChange={event=>{setSelectedDate(event.target.value);setSelectedIds([])}}>{[...dates].reverse().map(date=><option key={date} value={date}>{formatBookmarkDate(date)}</option>)}</select></label><div className="bookmark-layout-toggle"><button className={layout==='time'?'active':''} onClick={()=>setLayout('time')}>開始時刻順</button><button className={layout==='country'?'active':''} onClick={()=>setLayout('country')}>国・リーグ別</button></div><small>{layout==='time'?'00:00 → 23:59':'主要5か国を先頭、以降は国・リーグ名順'}</small></div>}<div className="bulk-actions bookmark-bulk-actions"><label><input type="checkbox" checked={allSelected} onChange={toggleAll} disabled={!selectable.length} /> この日の監視対象をすべて選択</label><button className="danger" disabled={!selected.length} onClick={()=>void excludeSelected()}>選択した{selected.length}試合をLIVE画面から外す</button><small>Bookmarkと保存済み履歴は残ります。</small></div>{!bookmarks.length?<div className="bookmark-list"><p>Bookmarkはまだありません</p></div>:layout==='time'?<div className="bookmark-list">{visibleBookmarks.length?visibleBookmarks.map(card):<p>この日のBookmarkはありません</p>}</div>:<div className="bookmark-country-groups">{countryGroups.length?countryGroups.map(country=><section className="bookmark-country-group" key={country.country}><header><h2>{country.flag} {country.country}</h2><span>{country.candidateCount}試合 · {country.leagues.length}リーグ</span></header>{country.leagues.map(league=><section className="bookmark-league-group" key={league.league}><h3>{league.league}<small>{league.candidates.length}試合</small></h3><div className="bookmark-list">{league.candidates.map(candidate=>card(candidate as Bookmark))}</div></section>)}</section>):<p>この日のBookmarkはありません</p>}</div>}</section>;
}

function bookmarkDate(bookmark: Bookmark) {
  const date=new Date(bookmark.kickoffUtc);
  if (Number.isNaN(date.getTime())) return '';
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date);
  const value=(type:string)=>parts.find(part=>part.type===type)?.value??'';
  return `${value('year')}-${value('month')}-${value('day')}`;
}

function formatBookmarkDate(value: string) {
  const [year,month,day]=value.split('-');
  return `${year}年${month}月${day}日`;
}

function ManagementBoard(props: { bookmarks:Bookmark[]; exclusions:MonitorExclusion[]; matches:Record<string,LiveMatch>; message:string; onRemove:(id:string)=>Promise<void>; onRestoreMonitoring:(id:string)=>Promise<void>; onBulkExclude:(items:Bookmark[])=>Promise<void>; onApplySavedAuto:()=>Promise<void>; applyingSavedAuto:boolean }) {
  return <section className="management-stage"><div className="management-intro"><span>MANAGEMENT</span><h1>Bookmark・監視対象外・保存済みデータ</h1><p>LIVE監視中に常時見る必要のない管理項目をここへまとめています。履歴データは削除されません。</p><button className="secondary" disabled={props.applyingSavedAuto} onClick={()=>void props.onApplySavedAuto()}>{props.applyingSavedAuto?'AUTO監視へ反映中…':'保存済み調子分析をAUTO監視へ反映（REST 0）'}</button><small>最新の保存済みform候補だけを、正式GOAL league IDのallowlistで再判定します。GOAL APIは呼びません。</small></div><BookmarkPanel {...props} /><div className="management-links"><a href="/live-history"><b>LIVE履歴</b><small>終了済み・途中終了をD1のsnapshotとsignalから確認</small></a><a href="/odds"><b>オッズ一覧</b><small>保存したオッズ取得履歴</small></a><a href="/analysis"><b>分析データ</b><small>AI分析用JSON・結果データ</small></a><a href="/form-history"><b>調子分析履歴</b><small>過去の直近5試合分析</small></a><a href="/monitor-exclusions"><b>監視対象外リスト</b><small>Bookmarkを残したままLIVE画面から隠した試合</small></a></div></section>;
}

function isSelectedLeague(fixture: UpcomingFixture) {
  const country = normalize(fixture.country);
  const league = normalize(fixture.league).replace(/\s+-\s+.*$/, '');
  const exact: Record<string, string[]> = {
    england: ['premier league', 'championship', 'league one', 'league two', 'efl league one', 'efl league two'],
    spain: ['la liga', 'laliga', 'primera division', 'segunda division', 'la liga 2', 'laliga2', 'primera federacion', 'primera rfef', 'primera division rfef'],
    italy: ['serie a', 'serie b', 'serie c', 'coppa italia'],
    germany: ['bundesliga', '2. bundesliga', '3. liga', '3 liga'],
    france: ['ligue 1', 'ligue 2', 'national', 'national 1', 'championnat national', 'national u19', 'u19 national'],
    iran: ['persian gulf pro league', 'pro league'],
    'saudi arabia': ['saudi league', 'pro league', 'saudi pro league', 'first division', 'division 1', '1st division', 'first league', 'yelo league'],
    bulgaria: ['first league'],
    austria: ['bundesliga'],
    denmark: ['superliga', '1st division', '1. division', 'division 1'],
    belgium: ['first division a', 'pro league', 'challenger pro league'],
    switzerland: ['super league'],
    scotland: ['premiership', 'championship', 'league one', 'league two'],
    turkey: ['super lig', 'superlig', '1. lig', '1 lig'],
    turkiye: ['super lig', 'superlig', '1. lig', '1 lig'],
    qatar: ['stars league', 'qatar stars league'],
    algeria: ['ligue 1'],
    poland: ['ekstraklasa', 'i liga', '1. liga', 'liga i'],
    estonia: ['esiliiga a'],
    armenia: ['premier league'],
    egypt: ['premier league'],
    hungary: ['nb i', 'nb 1', 'otp bank liga', 'bank liga'],
    netherlands: ['eredivisie', 'eerste divisie'],
    ecuador: ['liga pro', 'serie a', 'primera a'],
    brazil: ['serie a', 'serie b', 'brasileirao serie a', 'brasileirao serie b'],
    argentina: ['liga profesional', 'primera division'],
    colombia: ['primera a', 'liga betplay'],
    japan: ['j1 league', 'j league 1', 'j. league 1', 'j2 league', 'j league 2', 'j. league 2'],
    'south korea': ['k league 1', 'k league 2'],
    korea: ['k league 1', 'k league 2'],
    'korea republic': ['k league 1', 'k league 2'],
    thailand: ['thai league 1', 'league 1', 'thai league 2', 'league 2'],
    indonesia: ['liga 1', 'league 1'],
    norway: ['eliteserien', '1st division', '1. division', 'division 1', 'obos-ligaen', 'obos ligaen'],
    sweden: ['allsvenskan', 'superettan', 'ettan norra', 'ettan sodra', 'ettan'],
    albania: ['kategoria superiore', '1st division', '1. division', 'first division'],
    usa: ['major league soccer', 'mls'],
    'united states': ['major league soccer', 'mls'],
    mexico: ['liga mx'],
    portugal: ['primeira liga', 'liga portugal', 'liga portugal 2', 'liga portugal 2 sabseg'],
    romania: ['superliga', 'liga i'],
    serbia: ['superliga', 'prva liga'],
    slovakia: ['nike liga', 'fortuna liga', '2. liga', '2 liga'],
    slovenia: ['1. snl', '1 snl', 'prva liga', '2. snl', '2 snl'],
    chile: ['liga de primera', 'primera division'],
    china: ['super league', 'chinese super league'],
    'china pr': ['super league', 'chinese super league'],
    croatia: ['football league', 'croatian football league', 'hnl', '1. hnl'],
    cyprus: ['first division', '1st division', 'division 1'],
    finland: ['veikkausliiga', 'ykkonen', 'ykkosliiga'],
    peru: ['liga 1', 'primera division'],
    venezuela: ['primera division', 'liga futve'],
    paraguay: ['primera division', 'division profesional'],
    ireland: ['first division', '1st division', 'division 1'],
    'republic of ireland': ['first division', '1st division', 'division 1'],
    'united arab emirates': ['division 1', '1st division', 'first division', 'uae division 1'],
    uae: ['division 1', '1st division', 'first division', 'uae division 1'],
    latvia: ['virsliga', '1st division', 'first division', 'division 1'],
    'northern ireland': ['premiership', 'championship'],
    wales: ['cymru premier', 'premier league', 'premiership', 'championship', 'cymru north', 'cymru south'],
    greece: ['super league', 'super league 1', 'superleague'],
  };
  // UEFA competitions can be returned as Europe/World depending on the
  // provider feed, so they are intentionally league-name based.
  const uefaCompetitions = [
    'uefa champions league', 'champions league',
    'uefa europa league', 'europa league',
    'uefa europa conference league', 'europa conference league', 'conference league',
  ];
  const afcCompetitions = ['afc champions league', 'afc champions league elite', 'afc champions league two'];
  return (exact[country] ?? []).includes(league) || uefaCompetitions.includes(league) || afcCompetitions.includes(league);
}

function normalize(value: string) { return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase(); }

function MatchCard({ match, form, signals, onCapture, onSelectSnapshot, onRemove, onRefresh }: { match: LiveMatch; form: SavedForm | null; signals: LiveSignal[]; onCapture: () => void; onSelectSnapshot: (id: string) => void; onRemove: () => void; onRefresh: () => void }) {
  const status = displayMatchMinute(match.status);
  const selectedSnapshot = match.snapshots.find((snapshot) => snapshot.id === match.selectedSnapshotId);
  const lastReceivedMs = Date.parse(match.lastReceivedAt ?? '');
  const stale = !match.ended && Number.isFinite(lastReceivedMs) && Date.now() - lastReceivedMs >= 90_000;
  const waitingForProvider = !match.ended && !match.updates && !match.stats.length && match.subscriptionState === 'subscribed_waiting';
  const subscribedMs = Date.parse(match.subscribedAt ?? '');
  const providerSilent = match.subscriptionState === 'provider_silent';
  const initialResubscribeAttempts = match.initialUpdateResubscribeAttempts ?? 0;
  return <article className="score-card"><div className="league-line"><span>{match.country} · {match.league}</span><span className="fixture-controls"><b>{status}</b>{!match.ended && <button className="refresh-fixture" onClick={onRefresh}>再subscribe</button>}<button onClick={onRemove}>{match.ended ? '一覧から外す' : '監視から外す'}</button></span></div><div className="scoreline"><div><span className="crest home">{match.home.slice(0, 2).toUpperCase()}</span><div className="team-name-form"><strong>{match.home}</strong><FormStrip results={form?.home ?? null} /></div></div><p><b>{match.homeScore}</b><i>–</i><b>{match.awayScore}</b></p><div><span className="crest away">{match.away.slice(0, 2).toUpperCase()}</span><div className="team-name-form"><strong>{match.away}</strong><FormStrip results={form?.away ?? null} /></div></div></div><div className={`update-line ${stale ? 'stale' : ''}`}><span className="live-pill">● {match.historyFallback ? 'SAVED HISTORY' : match.ended ? 'FINISHED' : stale ? 'UPDATE STALE' : waitingForProvider ? 'SUBSCRIBED' : 'LIVE'}</span><span>{match.historyFallback ? `保存済みSocket履歴 · #${match.updates}` : match.updatedAt ? `Socket更新 ${match.updatedAt} JST · #${match.updates}${stale ? ' · provider更新停止を検知' : ''}` : waitingForProvider ? 'subscribe成功・最初のSocket更新（分数・stats）待ち' : 'subscribe応答待ち'}</span></div>
    <DangerousAttacksSignalPanel match={match} signals={signals} />
    <LateMatchComparisonPanel match={match} />
    <details className="snapshot-panel"><summary>SNAPSHOTS <small>手動スナップ</small></summary><div className="snapshot-actions"><button onClick={onCapture} disabled={!match.stats.length}>現在値をスナップ（REST 0）</button><span>{match.snapshots.length ? `${match.snapshots.length}件保存` : '好きな時点を保存できます'}</span></div>{match.snapshots.length > 0 && <div className="snapshot-tabs">{match.snapshots.map((snapshot) => <button className={snapshot.id === match.selectedSnapshotId ? 'active' : ''} onClick={() => onSelectSnapshot(snapshot.id)} key={snapshot.id}>{formatSnapshotStatus(snapshot.status)} <small>{snapshot.capturedAt}</small></button>)}</div>}</details>
    {selectedSnapshot && <SnapshotDeltaPanel match={match} snapshot={selectedSnapshot} />}
    {match.stats.length ? <div className="stats"><div className="stat-head"><span>HOME</span><b>CURRENT STATISTICS</b><span>AWAY</span></div>{match.stats.map((s, i) => { const unavailable = isGoalProviderPlaceholderZeroPair(s.type, s.home, s.away, match.status); return <div className="stat-row" key={`${s.type}-${i}`}><strong>{unavailable ? '—' : s.home ?? 'N/A'}</strong><span>{s.type}{unavailable ? '（GOAL API未提供）' : ''}</span><strong>{unavailable ? '—' : s.away ?? 'N/A'}</strong></div>; })}</div> : providerSilent ? <div className="waiting"><p>最初の更新が届かないため、自動再subscribeを{initialResubscribeAttempts}回試しました。GOAL APIの購読ストリームが無応答です。</p></div> : <div className="waiting"><span /><p>{initialResubscribeAttempts ? `最初の更新待ち（自動再subscribe ${initialResubscribeAttempts}/2）` : 'WebSocketの最初のmatch_updateを待っています'}</p></div>}
  </article>;
}

function FormStrip({ results }: { results: FormResult[] | null }) {
  if (!results?.length) return <small className="live-form-unavailable">直近5試合: 保存なし</small>;
  return <span className="live-form-strip" title="保存済みの直近5試合（左が古い試合）">{results.map((item, index) => <i key={`${item.fixtureId}-${index}`} className={item.result.toLowerCase()}>{item.result}</i>)}</span>;
}

function LateMatchComparisonPanel({ match }: { match: LiveMatch }) {
  return <><LateIntervalPanel label="65' → 70'" startLabel="65'" endLabel="70'" startMinute={match.minute65 ?? null} endMinute={match.minute70 ?? null} startStats={match.minute65Stats ?? null} endStats={match.minute70Stats ?? null} /><LateIntervalPanel label="70' → 75'" startLabel="70'" endLabel="75'" startMinute={match.minute70 ?? null} endMinute={match.minute75 ?? null} startStats={match.minute70Stats ?? null} endStats={match.minute75Stats ?? null} /><LateIntervalPanel label="75' → 80'" startLabel="75'" endLabel="80'" startMinute={match.minute75 ?? null} endMinute={match.minute80 ?? null} startStats={match.minute75Stats ?? null} endStats={match.minute80Stats ?? null} /></>;
}

function LateIntervalPanel({ label, startLabel, endLabel, startMinute, endMinute, startStats, endStats }: { label: string; startLabel: string; endLabel: string; startMinute: number | null; endMinute: number | null; startStats: Stat[] | null; endStats: Stat[] | null }) {
  const interval = { label, startLabel, endLabel, startMinute, endMinute, startStats, endStats };
  const ready = Boolean(interval.startStats?.length && interval.endStats?.length);
  const rows = ['Dangerous Attacks', 'On Target', 'Off Target', 'Corners'].map((type) => ({ type, home: statValue(interval.endStats ?? [], type, 'home'), away: statValue(interval.endStats ?? [], type, 'away'), baseHome: statValue(interval.startStats ?? [], type, 'home'), baseAway: statValue(interval.startStats ?? [], type, 'away') }));
  return <details className="snapshot-delta da-signal-panel interval-comparison-panel"><summary><b>{label} STAT SNAPSHOT</b><span>DA / On・Off Target / Corner</span></summary><div className="stat-head"><span>HOME</span><b>{ready ? `${interval.startMinute}' → ${interval.endMinute}'` : `${interval.startLabel} → ${interval.endLabel} checkpoint待ち`}</b><span>AWAY</span></div>{ready ? <>{rows.map((row) => <SignalStatRow key={row.type} label={`${row.type}（${interval.label}）`} home={row.home} away={row.away} baseHome={row.baseHome} baseAway={row.baseAway} />)}<small>Status: {interval.startMinute}' / {interval.endMinute}' の実際のSocket checkpoint比較（括弧内は開始時点からの増減）</small></> : <p className="no-delta">{interval.startLabel} と {interval.endLabel} の両方のcheckpointを待っています。</p>}</details>;
}

function DangerousAttacksSignalPanel({ match, signals }: { match: LiveMatch; signals: LiveSignal[] }) {
  const minute=parseElapsedMinute(match.status);
  const htHome=statValue(match.htStats??[],'Dangerous Attacks','home'); const htAway=statValue(match.htStats??[],'Dangerous Attacks','away');
  const currentHome=statValue(match.daCutoffStats??[],'Dangerous Attacks','home'); const currentAway=statValue(match.daCutoffStats??[],'Dangerous Attacks','away');
  const checkpointMinute=match.daCutoffMinute??null;
  const homeIncrease=htHome===null||currentHome===null?null:currentHome-htHome; const awayIncrease=htAway===null||currentAway===null?null:currentAway-htAway;
  const homeSignal=signals.find((signal)=>signal.ruleId==='dangerous_attacks_ht_increase'&&signal.ruleVersion==='v1'&&signal.signalSide==='HOME');
  const awaySignal=signals.find((signal)=>signal.ruleId==='dangerous_attacks_ht_increase'&&signal.ruleVersion==='v1'&&signal.signalSide==='AWAY');
  const homeFired=Boolean(homeSignal);
  const awayFired=Boolean(awaySignal);
  const homeHot=homeFired || (homeIncrease !== null && homeIncrease >= 15); const awayHot=awayFired || (awayIncrease !== null && awayIncrease >= 15);
  const baselineReady=htHome!==null&&htAway!==null;
  const isExplicitHt=['HT','HALF_TIME','HALF TIME','HALF-TIME'].includes(String(match.status).trim().toUpperCase());
  const state=minute!==null&&minute>65?'判定終了':!baselineReady?(isExplicitHt?'HT DA未取得 / 判定不可':minute!==null&&minute>45?'HT未取得 / 判定不可':'HT待ち'):'監視中';
  const koCurrentHome=statValue(match.koCutoffStats??[],'Dangerous Attacks','home'); const koCurrentAway=statValue(match.koCutoffStats??[],'Dangerous Attacks','away');
  const koHomeFired=signals.some((signal)=>signal.ruleId==='dangerous_attacks_first_25_level'&&signal.ruleVersion==='v1'&&signal.signalSide==='HOME');
  const koAwayFired=signals.some((signal)=>signal.ruleId==='dangerous_attacks_first_25_level'&&signal.ruleVersion==='v1'&&signal.signalSide==='AWAY');
  const koHomeHot=koHomeFired || (koCurrentHome !== null && koCurrentHome >= 20); const koAwayHot=koAwayFired || (koCurrentAway !== null && koCurrentAway >= 20);
  const koReady=koCurrentHome!==null&&koCurrentAway!==null; const koCheckpoint=match.koCutoffMinute??null;
  const koState=minute!==null&&minute>25?'判定終了':!koReady?'25分checkpoint待ち':'監視中';
  const koOnHome=statValue(match.koCutoffStats??[],'On Target','home'); const koOnAway=statValue(match.koCutoffStats??[],'On Target','away');
  const koOffHome=statValue(match.koCutoffStats??[],'Off Target','home'); const koOffAway=statValue(match.koCutoffStats??[],'Off Target','away');
  const currentOnHome=statValue(match.daCutoffStats??[],'On Target','home'); const currentOnAway=statValue(match.daCutoffStats??[],'On Target','away');
  const currentOffHome=statValue(match.daCutoffStats??[],'Off Target','home'); const currentOffAway=statValue(match.daCutoffStats??[],'Off Target','away');
  const cornersHome=statValue(match.daCutoffStats??[],'Corners','home'); const cornersAway=statValue(match.daCutoffStats??[],'Corners','away');
  const htOnHome=statValue(match.htStats??[],'On Target','home'); const htOnAway=statValue(match.htStats??[],'On Target','away');
  const htOffHome=statValue(match.htStats??[],'Off Target','home'); const htOffAway=statValue(match.htStats??[],'Off Target','away');
  const htCornersHome=statValue(match.htStats??[],'Corners','home'); const htCornersAway=statValue(match.htStats??[],'Corners','away');
  const homeCornersHot=cornersHome !== null && cornersHome >= 7; const awayCornersHot=cornersAway !== null && cornersAway >= 7;
  return <><details className="snapshot-delta da-signal-panel" open><summary><b>25' DANGEROUS ATTACKS SIGNAL</b><span>threshold DA 20</span></summary><div className="stat-head"><span>HOME</span><b>{koCheckpoint===null?'checkpoint待ち':`${koCheckpoint}'時点`}</b><span>AWAY</span></div><SignalStatRow label="DA（25分まで）" home={koCurrentHome} away={koCurrentAway} homeHot={koHomeHot} awayHot={koAwayHot} /><SignalStatRow label="On Target" home={koOnHome} away={koOnAway} /><SignalStatRow label="Off Target" home={koOffHome} away={koOffAway} /><div className="stat-row delta-row"><strong>{koHomeHot?'🔥 発火':'未発火'}</strong><span>DA 20以上</span><strong>{koAwayHot?'🔥 発火':'未発火'}</strong></div><small>Status: {koState}{minute!==null&&minute>25?'（表示値は25分以下の最終Socket snapshot）':koReady?` / HOME ${koHomeHot?'🔥 発火':'未発火'} / AWAY ${koAwayHot?'🔥 発火':'未発火'}`:''}</small></details><details className="snapshot-delta da-signal-panel" open><summary><b>HT → 65' DANGEROUS ATTACKS SIGNAL</b><span>DA +15 / Total Corner 7</span></summary><div className="stat-head"><span>HOME</span><b>{checkpointMinute===null?'checkpoint待ち':`${checkpointMinute}'まで`}</b><span>AWAY</span></div><SignalStatRow label="HT DA" home={htHome} away={htAway} /><SignalStatRow label="DA（65分まで・HT比）" home={currentHome} away={currentAway} baseHome={htHome} baseAway={htAway} /><SignalStatRow label="On Target（65分まで・HT比）" home={currentOnHome} away={currentOnAway} baseHome={htOnHome} baseAway={htOnAway} /><SignalStatRow label="Off Target（65分まで・HT比）" home={currentOffHome} away={currentOffAway} baseHome={htOffHome} baseAway={htOffAway} /><SignalStatRow label="Corners（試合合計・65分時点）" home={cornersHome} away={cornersAway} baseHome={htCornersHome} baseAway={htCornersAway} homeHot={homeCornersHot} awayHot={awayCornersHot} /><div className="stat-row delta-row"><strong className={homeHot?'signal-fired':''}>{!baselineReady?'—':homeIncrease===null?'—':`${homeHot?'🔥 ':''}${signed(homeIncrease)}`}</strong><span>{homeHot?'15到達・発火':'increase / +15'}</span><strong className={awayHot?'signal-fired':''}>{!baselineReady?'—':awayIncrease===null?'—':`${awayHot?'🔥 ':''}${signed(awayIncrease)}`}</strong></div><div className="stat-row delta-row"><strong className={homeSignal?'signal-fired':''}>{homeSignal ? `🔥 ${homeSignal.detectedMinute === null ? '発火' : `${homeSignal.detectedMinute}'`}` : '—'}</strong><span>DA +15 発火時点</span><strong className={awaySignal?'signal-fired':''}>{awaySignal ? `🔥 ${awaySignal.detectedMinute === null ? '発火' : `${awaySignal.detectedMinute}'`}` : '—'}</strong></div><div className="stat-row delta-row corner-threshold"><strong className={homeCornersHot?'signal-fired':''}>{cornersHome===null?'—':homeCornersHot?'🔥 7+':'未発火'}</strong><span>試合合計Corner 7以上</span><strong className={awayCornersHot?'signal-fired':''}>{cornersAway===null?'—':awayCornersHot?'🔥 7+':'未発火'}</strong></div><small>Status: {state}{minute!==null&&minute>65?'（表示値は65分以下の最終Socket snapshot）':baselineReady?` / HOME ${homeHot?'🔥 DA':''}${homeCornersHot?' 🔥 Corner':''}${!homeHot&&!homeCornersHot?' 未発火':''} / AWAY ${awayHot?'🔥 DA':''}${awayCornersHot?' 🔥 Corner':''}${!awayHot&&!awayCornersHot?' 未発火':''}`:''}</small></details></>;
}

function SignalStatRow({ label, home, away, baseHome = null, baseAway = null, homeHot = false, awayHot = false }: { label: string; home: number | null; away: number | null; baseHome?: number | null; baseAway?: number | null; homeHot?: boolean; awayHot?: boolean }) {
  return <div className="stat-row"><strong className={homeHot?'signal-fired':''}>{statWithIncrease(home, baseHome, homeHot)}</strong><span>{label}</span><strong className={awayHot?'signal-fired':''}>{statWithIncrease(away, baseAway, awayHot)}</strong></div>;
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

function parseElapsedMinute(status: string) { const match = /^(\d+)/.exec(String(status).trim()); return match ? Number(match[1]) : null; }

function formatSnapshotStatus(status: string) { return displayMatchMinute(status); }

function eventFromMatch(sessionId: string, match: LiveMatch, eventType: string, payload: unknown, receivedAt = new Date().toISOString()): MonitorEvent {
  return { sessionId, fixtureId: match.id, eventType, receivedAt, status: match.status, home: match.home, away: match.away, homeScore: match.homeScore, awayScore: match.awayScore, payload };
}

function persistEvents(events: MonitorEvent[]) {
  if (!events.length) return;
  void fetch('/api/monitor-events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ events }), keepalive: true }).catch(() => undefined);
}

function numeric(value: string | number | null) { const found = String(value ?? '').match(/-?\d+(?:\.\d+)?/); return found ? Number(found[0]) : null; }
function statValue(stats: Stat[], type: string, side: 'home'|'away') { const stat=stats.find((row)=>row.type.trim().toLowerCase()===type.toLowerCase()); return stat?numeric(stat[side]):null; }
function displayStat(value: number | null) { return value === null ? '—' : String(value); }
function statWithIncrease(value: number | null, baseline: number | null, hot = false) { if (value === null) return '—'; const increase = baseline === null ? null : value - baseline; return `${hot ? '🔥 ' : ''}${value}${increase === null ? '' : ` (${signed(increase)})`}`; }
function signed(value: number) { return value > 0 ? `+${value}` : String(value); }
