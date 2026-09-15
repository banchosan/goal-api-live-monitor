'use client';

import '../bookmarks.css';
import { useEffect, useState } from 'react';

type Exclusion = {
  fixtureId: string;
  home: string;
  away: string;
  reason: string;
  excludedAt: string;
};

export default function MonitorExclusionsPage() {
  const [exclusions, setExclusions] = useState<Exclusion[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');

  async function load() {
    setLoading(true);
    try {
      const response = await fetch('/api/monitor-exclusions', { cache: 'no-store' });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || '監視対象外リストを取得できませんでした');
      setExclusions(Array.isArray(body.exclusions) ? body.exclusions : []);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '監視対象外リストを取得できませんでした');
    } finally {
      setLoading(false);
    }
  }

  async function restore(fixtureId: string) {
    try {
      const response = await fetch(`/api/monitor-exclusions?fixtureId=${encodeURIComponent(fixtureId)}`, { method: 'DELETE' });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || 'LIVE画面への復帰に失敗しました');
      setExclusions(current => current.filter(row => row.fixtureId !== fixtureId));
      setMessage('LIVE画面からの非表示を解除しました。Bookmarkはそのまま残っています。');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'LIVE画面への復帰に失敗しました');
    }
  }

  useEffect(() => { void load(); }, []);

  return <main className="app-shell"><header className="topbar"><div className="brand"><span className="brand-ball">G</span><div><strong>GOAL LIVE</strong><small>WebSocket Stats Lab</small></div></div><a className="odds-nav" href="/">管理へ戻る</a></header><section className="management-stage"><div className="management-intro"><span>LIVE VISIBILITY</span><h1>監視対象外リスト</h1><p>ここにある試合はBookmarkを保持したまま、LIVE監視画面からだけ非表示にしています。</p></div>{message && <p className="exclusion-message">{message}</p>}<section className="bookmark-panel"><div className="bookmark-heading"><div><span>HIDDEN FROM LIVE</span><strong>{exclusions.length}</strong></div><button className="secondary" onClick={() => void load()} disabled={loading}>{loading ? '読込中…' : '更新'}</button></div><div className="bookmark-list">{exclusions.length ? exclusions.map(row => <article key={row.fixtureId}><div><b>{row.home || 'Home'} vs {row.away || 'Away'}</b><small>{row.reason || 'LIVE画面から非表示'}</small></div><time>{new Date(row.excludedAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}</time><button onClick={() => void restore(row.fixtureId)}>LIVE画面へ戻す</button></article>) : <p>{loading ? '読込中…' : '非表示中の試合はありません'}</p>}</div></section></section></main>;
}
