'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

type Fixture = { id: string; league: string; country: string; home: string; away: string; homeScore: string; awayScore: string; status: string };
type Stat = { type: string; home: string | number | null; away: string | number | null };
type LiveMatch = Fixture & { stats: Stat[]; updatedAt?: string; updates: number; htStats?: Stat[]; sixtyStats?: Stat[]; sixtyMinute?: number };
const WS_URL = 'wss://api.goal-api.com/ws';

export default function Home() {
  const [fixtures, setFixtures] = useState<Fixture[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [matches, setMatches] = useState<Record<string, LiveMatch>>({});
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [connection, setConnection] = useState<'idle' | 'connecting' | 'live' | 'error'>('idle');
  const [message, setMessage] = useState('「ライブ試合を取得」を押してください');
  const [restCount, setRestCount] = useState(0);
  const [frameCount, setFrameCount] = useState(0);
  const socketRef = useRef<WebSocket | null>(null);
  const visible = useMemo(() => fixtures.filter((f) => `${f.home} ${f.away} ${f.league} ${f.country}`.toLowerCase().includes(query.toLowerCase())), [fixtures, query]);
  const additionalIds = selected.filter((id) => !matches[id]);
  const availableSlots = Math.max(0, 25 - Object.keys(matches).length);
  const addableIds = additionalIds.slice(0, availableSlots);

  async function loadFixtures() {
    setLoading(true); setMessage('GOAL APIからライブ試合を取得中…');
    try {
      const response = await fetch('/api/live', { cache: 'no-store' });
      setRestCount((v) => v + 1);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'ライブ一覧を取得できませんでした');
      setFixtures(data.fixtures); setMessage(`${data.fixtures.length}試合を取得しました。監視する試合を選択してください。`);
    } catch (error) { setMessage(error instanceof Error ? error.message : '取得エラー'); }
    finally { setLoading(false); }
  }

  function toggle(id: string) { setSelected((now) => now.includes(id) ? now.filter((v) => v !== id) : now.length < 25 ? [...now, id] : now); }

  async function startMonitoring() {
    if (!selected.length) return;
    socketRef.current?.close(); setConnection('connecting'); setMessage('WebSocketへ接続中…');
    setMatches(Object.fromEntries(selected.map((id) => { const f = fixtures.find((x) => x.id === id)!; return [id, { ...f, stats: [], updates: 0 }]; })));
    try {
      const response = await fetch('/api/ws-token', { method: 'POST' }); setRestCount((v) => v + 1);
      const body = await response.json();
      if (!response.ok || !body.token) throw new Error(body.error || 'WebSocket token取得失敗');
      const socket = new WebSocket(`${WS_URL}?wsToken=${encodeURIComponent(body.token)}`); socketRef.current = socket;
      socket.onopen = () => socket.send(JSON.stringify({ type: 'auth', token: body.token }));
      socket.onmessage = (event) => {
        setFrameCount((v) => v + 1); const payload = JSON.parse(String(event.data));
        if (payload.type === 'auth_success') { selected.forEach((id) => socket.send(JSON.stringify({ type: 'subscribe', resource: 'match', matchId: id }))); return; }
        if (payload.type === 'subscribe_response') { if (payload.success) { setConnection('live'); setMessage(`${selected.length}試合をWebSocket監視中。受信フレームのREST消費は0です。`); } return; }
        if (payload.type !== 'match_update') return;
        const data = payload.data ?? {}; const id = data.id ?? data.fixture_id ?? data.fixtureId;
        setMatches((now) => {
          if (!now[id]) return now;
          const previous = now[id];
          const nextStatus = String(data.match_status ?? previous.status);
          const nextStats = Array.isArray(data.statistics) ? data.statistics : previous.stats;
          const minute = /^\d+$/.test(nextStatus) ? Number(nextStatus) : null;
          const previousMinute = /^\d+$/.test(previous.status) ? Number(previous.status) : null;
          const isHalfTime = ['HT', 'HALF_TIME', 'HALF TIME'].includes(nextStatus.toUpperCase());
          let htStats = previous.htStats;
          if (isHalfTime && nextStats.length) htStats = nextStats;
          else if (minute !== null && minute <= 45 && nextStats.length) htStats = nextStats;
          else if (!htStats && minute !== null && minute >= 46 && previousMinute !== null && previousMinute <= 45 && previous.stats.length) htStats = previous.stats;
          let sixtyStats = previous.sixtyStats;
          let sixtyMinute = previous.sixtyMinute;
          if (!sixtyStats && htStats && minute !== null && minute >= 60 && nextStats.length) { sixtyStats = nextStats; sixtyMinute = minute; }
          return { ...now, [id]: { ...previous, home: data.match_hometeam_name ?? previous.home, away: data.match_awayteam_name ?? previous.away, homeScore: data.match_hometeam_score ?? previous.homeScore, awayScore: data.match_awayteam_score ?? previous.awayScore, status: nextStatus, stats: nextStats, htStats, sixtyStats, sixtyMinute, updatedAt: new Date().toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo' }), updates: previous.updates + 1 } };
        });
      };
      socket.onerror = () => { setConnection('error'); setMessage('WebSocket接続エラー'); };
      socket.onclose = () => setConnection((v) => v === 'error' ? v : 'idle');
    } catch (error) { setConnection('error'); setMessage(error instanceof Error ? error.message : '接続エラー'); }
  }

  function addSelectedMatches() {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN || !addableIds.length) return;
    setMatches((now) => {
      const additions = Object.fromEntries(addableIds.map((id) => {
        const fixture = fixtures.find((item) => item.id === id)!;
        return [id, { ...fixture, stats: [], updates: 0 }];
      }));
      return { ...now, ...additions };
    });
    addableIds.forEach((id) => socket.send(JSON.stringify({ type: 'subscribe', resource: 'match', matchId: id })));
    setMessage(`${addableIds.length}試合を現在のWebSocket監視へ追加しました。REST消費は0です。`);
  }

  function stopMonitoring() {
    const socket = socketRef.current;
    if (socket) Object.keys(matches).forEach((id) => socket.send(JSON.stringify({ type: 'unsubscribe', resource: 'match', matchId: id })));
    socket?.close(1000, 'user stopped'); socketRef.current = null; setConnection('idle'); setMessage('監視を停止しました');
  }
  useEffect(() => () => socketRef.current?.close(), []);

  return <main className="app-shell">
    <header className="topbar">
      <div className="brand"><span className="brand-ball">G</span><div><strong>GOAL LIVE</strong><small>WebSocket Stats Lab</small></div></div>
      <div className="health"><span className={`dot ${connection}`} />{connection === 'live' ? 'LIVE CONNECTED' : connection === 'connecting' ? 'CONNECTING' : connection === 'error' ? 'CONNECTION ERROR' : 'SOCKET OFF'}</div>
      <div className="quota"><span>REST USED</span><strong>{restCount}</strong><small>WS frames {frameCount}</small></div>
    </header>
    <section className="commandbar"><div><h1>ライブ試合を選んで、リアルタイムで見る。</h1><p>{message}</p></div><div className="actions">
      <button className="secondary" onClick={loadFixtures} disabled={loading}>{loading ? '取得中…' : fixtures.length ? '一覧を更新（1 REST）' : 'ライブ試合を取得（1 REST）'}</button>
      {connection === 'live' ? <><button className="primary" onClick={addSelectedMatches} disabled={!addableIds.length || !availableSlots}>選択から{addableIds.length}試合を追加</button><button className="danger" onClick={stopMonitoring}>監視を停止</button></> : connection === 'connecting' ? <button className="danger" onClick={stopMonitoring}>接続を中止</button> : <button className="primary" onClick={startMonitoring} disabled={!selected.length}>選択した{selected.length}試合を監視</button>}
    </div></section>
    <div className="workspace">
      <aside className="match-picker"><div className="picker-head"><div><span className="eyebrow">LIVE MATCHES</span><strong>{fixtures.length}</strong></div><span className="selection-count">{selected.length}/25 選択</span></div>
        <input aria-label="試合検索" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="チーム・リーグを検索" />
        <div className="fixture-list">{!fixtures.length && <div className="empty"><span>◉</span><p>まだ一覧を取得していません</p><small>一覧取得は1 REST requestです</small></div>}
          {visible.map((f) => <label key={f.id} className={`fixture ${selected.includes(f.id) ? 'chosen' : ''}`}><input type="checkbox" checked={selected.includes(f.id)} onChange={() => toggle(f.id)} /><div className="fixture-main"><small>{f.country} · {f.league}</small><div><span>{f.home}</span><b>{f.homeScore}</b></div><div><span>{f.away}</span><b>{f.awayScore}</b></div></div><span className="minute">{/^\d+$/.test(f.status) ? `${f.status}'` : f.status}</span></label>)}
        </div>
      </aside>
      <section className="score-stage">{!Object.keys(matches).length && <div className="hero-empty"><div className="pulse-rings"><span /><span /><b>⚽</b></div><h2>試合を選択してください</h2><p>左のライブ一覧から最大25試合を選び、1本のSocketで同時監視できます。</p><div className="flow"><span>LIVE LIST<small>1 REST</small></span><i>→</i><span>SELECT<small>最大25試合</small></span><i>→</i><span>WEBSOCKET<small>更新消費 0</small></span></div></div>}
        <div className="cards-grid">{Object.values(matches).map((m) => <MatchCard key={m.id} match={m} />)}</div>
      </section>
    </div>
  </main>;
}

function MatchCard({ match }: { match: LiveMatch }) {
  const status = /^\d+(?:\+\d+)?$/.test(match.status) ? `${match.status}'` : match.status;
  return <article className="score-card"><div className="league-line"><span>{match.country} · {match.league}</span><b>{status}</b></div><div className="scoreline"><div><span className="crest home">{match.home.slice(0, 2).toUpperCase()}</span><strong>{match.home}</strong></div><p><b>{match.homeScore}</b><i>–</i><b>{match.awayScore}</b></p><div><span className="crest away">{match.away.slice(0, 2).toUpperCase()}</span><strong>{match.away}</strong></div></div><div className="update-line"><span className="live-pill">● LIVE</span><span>{match.updatedAt ? `更新 ${match.updatedAt} JST · #${match.updates}` : '初回データ待機中'}</span></div>
    {match.htStats && <DeltaPanel match={match} />}
    {match.stats.length ? <div className="stats"><div className="stat-head"><span>HOME</span><b>CURRENT STATISTICS</b><span>AWAY</span></div>{match.stats.map((s, i) => <div className="stat-row" key={`${s.type}-${i}`}><strong>{s.home ?? 'N/A'}</strong><span>{s.type}</span><strong>{s.away ?? 'N/A'}</strong></div>)}</div> : <div className="waiting"><span /><p>WebSocketのmatch_updateを待っています</p></div>}
  </article>;
}

function DeltaPanel({ match }: { match: LiveMatch }) {
  const target = match.sixtyStats ?? match.stats;
  const baseline = new Map(match.htStats?.map((stat) => [stat.type, stat]));
  const rows = target.flatMap((stat) => {
    const before = baseline.get(stat.type);
    if (!before) return [];
    const home = numeric(stat.home), away = numeric(stat.away), baseHome = numeric(before.home), baseAway = numeric(before.away);
    if (home === null || away === null || baseHome === null || baseAway === null) return [];
    return [{ type: stat.type, home: home - baseHome, away: away - baseAway }];
  });
  const currentMinute = /^\d+$/.test(match.status) ? Number(match.status) : null;
  const title = match.sixtyStats ? `HT → ${match.sixtyMinute}分 SNAPSHOT` : `HT → ${currentMinute ?? match.status} LIVE DELTA`;
  return <div className={`delta-panel ${match.sixtyStats ? 'locked' : ''}`}><div className="delta-title"><b>{title}</b><span>{match.sixtyStats ? '固定済み' : '60分到達待ち'}</span></div><div className="stat-head"><span>HOME ±</span><b>CHANGE</b><span>AWAY ±</span></div>{rows.map((row, index) => <div className="stat-row delta-row" key={`${row.type}-${index}`}><strong>{signed(row.home)}</strong><span>{row.type}</span><strong>{signed(row.away)}</strong></div>)}</div>;
}

function numeric(value: string | number | null) { const found = String(value ?? '').match(/-?\d+(?:\.\d+)?/); return found ? Number(found[0]) : null; }
function signed(value: number) { return value > 0 ? `+${value}` : String(value); }
