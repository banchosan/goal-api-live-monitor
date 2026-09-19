'use client';

import { useEffect, useMemo, useState } from 'react';
import { groupFormCandidates, type FormHistoryCandidate } from '@/lib/form-history-grouping';

type Result = { result: string; score: string; opponent: string; fixtureId: string };
type Candidate = FormHistoryCandidate & { kickoffUtc: string; kickoffJst: string; home?: string; away?: string; homeTeamId?: string; awayTeamId?: string; leagueId?: string; side: 'home' | 'away'; opponent: string; wins: number; draws: number; last5: Result[] };
type Run = { runId: string; createdAt: string; checkedTeams: number; failedTeams: number; apiRequests: number; candidateCount: number };
type Data = { runs: Run[]; selectedRun: Run | null; candidates: Candidate[] };

function CandidateCard({ candidate }: { candidate: Candidate }) {
  return <article className="candidate-card">
    <div><time>{candidate.kickoffJst} JST</time><b>{candidate.wins}W {candidate.draws}D / 5</b></div>
    <h3>{candidate.team}</h3><p>{candidate.side.toUpperCase()} vs {candidate.opponent}</p><small>{candidate.country} · {candidate.league}</small>
    <div className="form-strip">{candidate.last5.map((result, index) => <span className={result.result.toLowerCase()} title={`${result.opponent} ${result.score}`} key={`${result.fixtureId}-${index}`}>{result.result}</span>)}</div>
  </article>;
}

export default function FormHistory() {
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [oddsLoading, setOddsLoading] = useState(false);
  const [oddsStatus, setOddsStatus] = useState('');
  const [layout, setLayout] = useState<'cards' | 'country'>('cards');

  async function load(runId?: string) {
    setLoading(true); setError('');
    try {
      const response = await fetch(`/api/form-history${runId ? `?runId=${encodeURIComponent(runId)}` : ''}`, { cache: 'no-store' });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? '履歴取得失敗');
      setData(body);
    } catch (caught) { setError(caught instanceof Error ? caught.message : '履歴取得失敗'); }
    finally { setLoading(false); }
  }

  async function getOdds() {
    if (!data?.selectedRun || !data.candidates.length || oddsLoading) return;
    setOddsLoading(true); setOddsStatus('保存済み候補からオッズを取得中… GOAL form APIは呼びません。');
    try {
      const response = await fetch('/api/candidate-odds', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ formRunId: data.selectedRun.runId, candidates: data.candidates }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? 'オッズ取得失敗');
      setOddsStatus(`今回 ${body.matched ?? 0}試合保存 / 残り ${body.remaining ?? 0}。${body.haltedForRateLimit ? '429のため停止。時間を置いて同じボタンでresumeできます。' : (body.remaining ? '同じボタンで次batchを続行できます。' : '完了。')}`);
    } catch (caught) { setOddsStatus(caught instanceof Error ? caught.message : 'オッズ取得失敗'); }
    finally { setOddsLoading(false); }
  }

  useEffect(() => { void load(); }, []);
  const groups = useMemo(() => groupFormCandidates(data?.candidates ?? []), [data?.candidates]);

  return <main className="odds-shell">
    <header className="odds-topbar"><div className="brand"><span className="brand-ball">F</span><div><strong>FORM HISTORY</strong><small>AUTO SAVED</small></div></div><a className="back-link" href="/">← 24時間・ライブ画面へ</a></header>
    <section className="odds-hero"><div><span className="eyebrow">WATCH CANDIDATES</span><h1>直近5試合・調子分析履歴</h1><p>分析ボタンを押した結果は毎回自動保存。履歴閲覧・保存済み候補からのオッズ取得はGOAL API消費0です。</p></div><div className="odds-summary"><b>{data?.candidates.length ?? '—'}</b><span>候補チーム</span><small>{data?.selectedRun ? fmt(data.selectedRun.createdAt) : loading ? '読込中' : '履歴なし'}</small></div></section>
    <section className="odds-tools">
      <select value={data?.selectedRun?.runId ?? ''} onChange={(event) => void load(event.target.value)} disabled={loading || oddsLoading}>{(data?.runs ?? []).map((run) => <option value={run.runId} key={run.runId}>{fmt(run.createdAt)} · 候補{run.candidateCount} · 確認{run.checkedTeams}チーム · {run.apiRequests} REST</option>)}</select>
      <button className={layout === 'cards' ? 'secondary form-layout-active' : 'secondary'} onClick={() => setLayout('cards')} disabled={loading}>標準表示</button>
      <button className={layout === 'country' ? 'secondary form-layout-active' : 'secondary'} onClick={() => setLayout('country')} disabled={loading}>国・リーグ別</button>
      <button className="secondary" onClick={getOdds} disabled={oddsLoading || !data?.candidates.length}>{oddsLoading ? 'オッズ取得中…' : '保存済み候補からオッズ取得（40件ずつ）'}</button>
      <span>{data?.selectedRun ? `失敗 ${data.selectedRun.failedTeams}チーム` : ''}</span>
    </section>
    {layout === 'country' && !!data?.candidates.length && <p className="form-history-order">表示順: 🇬🇧 England / 🇪🇸 Spain / 🇩🇪 Germany / 🇮🇹 Italy / 🇫🇷 France を先頭固定。以降は国名・リーグ名のアルファベット順です。</p>}
    {oddsStatus && <div className="analysis-message">{oddsStatus}</div>}
    {error && <div className="analysis-message">{error}</div>}
    {layout === 'cards'
      ? <section className="candidate-grid form-history-grid">{(data?.candidates ?? []).map((candidate) => <CandidateCard candidate={candidate} key={`${candidate.fixtureId}-${candidate.team}`} />)}</section>
      : <section className="form-history-groups">{groups.map((country) => <section className="form-country-group" key={country.country}><header><h2>{country.flag} {country.country}</h2><span>{country.candidateCount}候補 · {country.leagues.length}リーグ</span></header>{country.leagues.map((league) => <section className="form-league-group" key={league.league}><h3>{league.league}<small>{league.candidates.length}候補</small></h3><div className="candidate-grid">{league.candidates.map((candidate) => <CandidateCard candidate={candidate as Candidate} key={`${candidate.fixtureId}-${candidate.team}`} />)}</div></section>)}</section>)}</section>}
    {!loading && !error && !data?.runs.length && <section className="unmatched"><h2>調子分析履歴はまだありません</h2><p>24時間画面で「直近5試合を分析」を押すと自動保存されます。</p></section>}
  </main>;
}

function fmt(value: string) {
  return new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(value)) + ' JST';
}
