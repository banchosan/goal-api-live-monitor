import test from 'node:test'; import assert from 'node:assert/strict';
import { BookmarkScheduler } from '../../../services/collector/bookmark-scheduler.mjs';

function setup(bookmarks, fixtures=[], active=fixtures.length>0) {
  const calls=[]; let state={active,fixtures};
  const collector={status:()=>structuredClone(state),start:async xs=>{calls.push(['start',xs]);state={active:true,fixtures:xs}},add:async xs=>{calls.push(['add',xs]);state.fixtures.push(...xs)},remove:async(id)=>{calls.push(['remove',id]);state.fixtures=state.fixtures.filter(f=>f.id!==id)}};
  const scheduler=new BookmarkScheduler({collector,now:()=>Date.parse('2026-09-07T12:00:00Z'),fetchImpl:async()=>({ok:true,json:async()=>({bookmarks})})}); return {scheduler,calls,state:()=>state};
}
const row=(id,kickoff='2026-09-07T12:02:00Z',status='waiting')=>({fixtureId:id,home:'H',away:'A',league:'L',country:'C',kickoffUtc:kickoff,status});
test('kickoff前のBookmarkから一つのCollector sessionを開始する',async()=>{const s=setup([row('a')]);assert.deepEqual((await s.scheduler.tick()).added,['a']);assert.equal(s.calls[0][0],'start')});
test('既存manual sessionへBookmarkを追加する',async()=>{const s=setup([row('b')],[{id:'manual',monitorSource:'manual'}]);await s.scheduler.tick();assert.equal(s.calls[0][0],'add');assert.equal(s.state().fixtures.length,2)});
test('25枠超過はkickoff順でqueueする',async()=>{const current=Array.from({length:24},(_,i)=>({id:`m${i}`}));const s=setup([row('late','2026-09-07T12:02:30Z'),row('early','2026-09-07T12:01:00Z')],current);const result=await s.scheduler.tick();assert.deepEqual(result.added,['early']);assert.equal(result.queued,1)});
test('daemon restart後はmonitoring Bookmarkを即時復元する',async()=>{const s=setup([row('a','2026-09-07T20:00:00Z','monitoring')]);await s.scheduler.tick();assert.equal(s.calls[0][0],'start')});
test('removed BookmarkはBookmark由来の監視だけ外す',async()=>{const s=setup([row('a','2026-09-07T12:00:00Z','removed')],[{id:'a',monitorSource:'bookmark'}]);await s.scheduler.tick();assert.deepEqual(s.calls[0],['remove','a'])});
