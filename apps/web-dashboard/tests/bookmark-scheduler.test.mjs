import test from 'node:test'; import assert from 'node:assert/strict';
import { BookmarkScheduler } from '../../../services/collector/bookmark-scheduler.mjs';

function setup(bookmarks, fixtures=[], active=fixtures.length>0, exclusions=[]) {
  const calls=[]; let state={active,fixtures};
  const collector={status:()=>structuredClone(state),start:async xs=>{calls.push(['start',xs]);state={active:true,fixtures:xs}},add:async xs=>{calls.push(['add',xs]);state.fixtures.push(...xs)},remove:async(id)=>{calls.push(['remove',id]);state.fixtures=state.fixtures.filter(f=>f.id!==id)}};
  const scheduler=new BookmarkScheduler({collector,now:()=>Date.parse('2026-09-07T12:00:00Z'),fetchImpl:async(url)=>({ok:true,json:async()=>url.includes('monitor-exclusions')?{exclusions}:{bookmarks}})}); return {scheduler,calls,state:()=>state};
}
const row=(id,kickoff='2026-09-07T12:02:00Z',status='waiting')=>({fixtureId:id,home:'H',away:'A',league:'L',country:'C',kickoffUtc:kickoff,status});
test('kickoff前のBookmarkから一つのCollector sessionを開始する',async()=>{const s=setup([row('a')]);assert.deepEqual((await s.scheduler.tick()).added,['a']);assert.equal(s.calls[0][0],'start')});
test('既存manual sessionへBookmarkを追加する',async()=>{const s=setup([row('b')],[{id:'manual',monitorSource:'manual'}]);await s.scheduler.tick();assert.equal(s.calls[0][0],'add');assert.equal(s.state().fixtures.length,2)});
test('AUTO_FORM Bookmarkも既存Schedulerへ同じsourceで渡す',async()=>{const auto={...row('auto'),monitorSource:'auto_form'};const s=setup([auto]);await s.scheduler.tick();assert.equal(s.calls[0][1][0].monitorSource,'auto_form')});
test('25枠超過はkickoff順でqueueする',async()=>{const current=Array.from({length:24},(_,i)=>({id:`m${i}`}));const s=setup([row('late','2026-09-07T12:02:30Z'),row('early','2026-09-07T12:01:00Z')],current);const result=await s.scheduler.tick();assert.deepEqual(result.added,['early']);assert.equal(result.queued,1)});
test('30 AUTO_FORM fixtures use the shared 25-slot queue',async()=>{const rows=Array.from({length:30},(_,i)=>({...row(`a${i}`,new Date(Date.parse('2026-09-07T11:00:00Z')+i*60_000).toISOString()),monitorSource:'auto_form'}));const s=setup(rows);const result=await s.scheduler.tick();assert.equal(result.added.length,25);assert.equal(result.queued,5);assert.equal(s.state().fixtures.every(x=>x.monitorSource==='auto_form'),true)});
test('daemon restart後はmonitoring Bookmarkを即時復元する',async()=>{const s=setup([row('a','2026-09-07T20:00:00Z','monitoring')]);await s.scheduler.tick();assert.equal(s.calls[0][0],'start')});
test('Bookmarkを外しても現在の監視は独立して継続する',async()=>{const s=setup([row('a','2026-09-07T12:00:00Z','removed')],[{id:'a',monitorSource:'bookmark'}]);await s.scheduler.tick();assert.equal(s.calls.length,0);assert.equal(s.state().fixtures.length,1)});
test('監視除外中のBookmarkはschedulerが再追加しない',async()=>{const s=setup([row('a')],[],false,[{fixtureId:'a'}]);const result=await s.scheduler.tick();assert.deepEqual(result.added,[]);assert.equal(s.calls.length,0)});
test('監視中fixtureを永続除外するとBookmarkを残して監視だけ外す',async()=>{const s=setup([row('a','2026-09-07T12:00:00Z','monitoring')],[{id:'a',monitorSource:'bookmark'}],true,[{fixtureId:'a'}]);await s.scheduler.tick();assert.deepEqual(s.calls[0],['remove','a']);assert.equal(s.state().fixtures.length,0)});
