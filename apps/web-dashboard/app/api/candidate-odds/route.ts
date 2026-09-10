import { env } from 'cloudflare:workers';
import { ensureRuntimeSchema } from '@/db/schema';
import { matchFixturePair, type FixtureContext } from '@/lib/fixture-identity-bridge';
import { saveSafeFixtureIdentity } from '@/lib/fixture-identity-store';

export const dynamic = 'force-dynamic';
const BASE = 'https://v3.football.api-sports.io';
type Candidate = { fixtureId:string;kickoffUtc:string;kickoffJst:string;league:string;country:string;team:string;teamId:string;side:'home'|'away';opponent:string;home:string;away:string;homeTeamId:string;awayTeamId:string };
type Target = { goal: FixtureContext };

function normalized(value:string){return value.normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\b(fc|fk|sc|cf|as|jk|club)\b/g,' ').replace(/[^a-z0-9]+/g,' ').trim()}
function sameName(a:string,b:string){const x=normalized(a),y=normalized(b);if(x===y||x.includes(y)||y.includes(x))return true;const xs=new Set(x.split(' ').filter(v=>v.length>2)),ys=new Set(y.split(' ').filter(v=>v.length>2));return [...xs].filter(v=>ys.has(v)).length>=Math.min(2,xs.size,ys.size)}
function jstDate(value:string){return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value))}
function targets(candidates:Candidate[]){const map=new Map<string,Target>();for(const c of candidates){if(map.has(c.fixtureId))continue;map.set(c.fixtureId,{goal:{id:c.fixtureId,kickoffUtc:c.kickoffUtc,league:c.league,country:c.country,home:{id:c.homeTeamId,name:c.home},away:{id:c.awayTeamId,name:c.away}}})}return [...map.values()]}
function apiContext(value:any):FixtureContext|null{const fixture=value?.fixture,league=value?.league,home=value?.teams?.home,away=value?.teams?.away;if(!fixture?.id||!fixture?.date||!league?.name||!home?.id||!home?.name||!away?.id||!away?.name)return null;return{id:String(fixture.id),kickoffUtc:String(fixture.date),league:String(league.name),country:league.country?String(league.country):undefined,home:{id:String(home.id),name:String(home.name)},away:{id:String(away.id),name:String(away.name)}}}

export async function POST(request:Request){
  const key=process.env.API_FOOTBALL_KEY;if(!key)return Response.json({error:'API_FOOTBALL_KEYが未設定です',apiRequests:0},{status:500});
  const body=await request.json().catch(()=>null);const list=targets(Array.isArray(body?.candidates)?body.candidates:[]);if(!list.length)return Response.json({error:'候補試合がありません',apiRequests:0},{status:400});if(list.length>40)return Response.json({error:'一度に取得できる候補は40試合までです',apiRequests:0},{status:400});
  let apiRequests=0,lastRequest=0;const requestApi=async(endpoint:string,params:Record<string,string>)=>{const wait=6500-(Date.now()-lastRequest);if(wait>0)await new Promise(r=>setTimeout(r,wait));const response=await fetch(`${BASE}${endpoint}?${new URLSearchParams(params)}`,{headers:{'x-apisports-key':key},cache:'no-store'});lastRequest=Date.now();apiRequests++;const payload=await response.json();if(!response.ok)throw new Error(`API-Football HTTP ${response.status}`);return payload};
  const fixtureResponses=[];const fixtures:any[]=[];for(const date of [...new Set(list.map(t=>jstDate(t.goal.kickoffUtc)))]){const payload=await requestApi('/fixtures',{date,timezone:'Asia/Tokyo'});fixtureResponses.push({date,payload});fixtures.push(...(payload.response??[]))}
  const db=(env as unknown as{DB:D1Database}).DB;await ensureRuntimeSchema(db);const matched=[];const unmatched=[];const identity={saved:0,noop:0,skipped:0,conflict:0};for(const target of list){const candidates=fixtures.map(f=>({fixture:f,context:apiContext(f)})).filter((pair):pair is {fixture:any;context:FixtureContext}=>!!pair.context&&sameName(target.goal.home.name,pair.context.home.name)&&sameName(target.goal.away.name,pair.context.away.name));const safe=candidates.filter(pair=>matchFixturePair(target.goal,pair.context).status==='SAFE_MATCH');const chosen=safe.length===1?safe[0].fixture:candidates[0]?.fixture;if(!chosen){unmatched.push(target);continue}if(safe.length===1){const result=await saveSafeFixtureIdentity(db,target.goal,safe[0].context);identity[result.status]+=1}else identity.skipped+=1;const raw=await requestApi('/odds',{fixture:String(chosen.fixture.id)});matched.push({target,fixture:chosen,raw})}
  const createdAt=new Date().toISOString(),runId=`${createdAt}-${crypto.randomUUID()}`;await db.prepare(`INSERT INTO odds_analysis_runs (run_id,form_run_id,created_at,api_requests,matched_fixtures,unmatched_json,fixtures_json) VALUES (?,?,?,?,?,?,?)`).bind(runId,body?.formRunId??null,createdAt,apiRequests,matched.length,JSON.stringify(unmatched),JSON.stringify(fixtureResponses)).run();
  if(matched.length){const insert=db.prepare(`INSERT INTO odds_snapshots (run_id,api_fixture_id,kickoff,home,away,raw_json) VALUES (?,?,?,?,?,?)`);await db.batch(matched.map(item=>insert.bind(runId,String(item.fixture.fixture.id),item.fixture.fixture.date,item.fixture.teams.home.name,item.fixture.teams.away.name,JSON.stringify(item.raw))))}
  return Response.json({runId,saved:true,apiRequests,matched:matched.length,unmatched,identity});
}
