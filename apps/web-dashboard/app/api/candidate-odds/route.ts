import { env } from 'cloudflare:workers';
import { ensureRuntimeSchema } from '@/db/schema';
import { matchFixturePair, type FixtureContext } from '@/lib/fixture-identity-bridge';
import { saveSafeFixtureIdentity } from '@/lib/fixture-identity-store';
import { saveTypedOdds } from '@/lib/prematch-dual-write';
import { ApiFootballResponseError, apiFootballFailure, internalApiFootballFailure, parseApiFootballResponse, publicApiFootballFailure } from '@/lib/api-football-response';

export const dynamic = 'force-dynamic';
const BASE = 'https://v3.football.api-sports.io';
type Candidate = { fixtureId?:unknown;kickoffUtc?:unknown;kickoffJst?:unknown;league?:unknown;country?:unknown;team?:unknown;teamId?:unknown;side?:unknown;opponent?:unknown;home?:unknown;away?:unknown;homeTeamId?:unknown;awayTeamId?:unknown };
type Target = { goal: FixtureContext };

function requiredText(value:unknown){return typeof value==='string'&&value.trim()?value.trim():null}
function normalized(value:unknown){const text=requiredText(value);return text?text.normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\b(fc|fk|sc|cf|as|jk|club)\b/g,' ').replace(/[^a-z0-9]+/g,' ').trim():null}
function sameName(a:unknown,b:unknown){const x=normalized(a),y=normalized(b);if(!x||!y)return false;if(x===y||x.includes(y)||y.includes(x))return true;const xs=new Set(x.split(' ').filter(v=>v.length>2)),ys=new Set(y.split(' ').filter(v=>v.length>2));return [...xs].filter(v=>ys.has(v)).length>=Math.min(2,xs.size,ys.size)}
function jstDate(value:string){return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value))}
function targets(candidates:Candidate[]){const map=new Map<string,Target>(),invalid:any[]=[];for(const [index,c] of candidates.entries()){const fields={fixtureId:requiredText(c.fixtureId),kickoffUtc:requiredText(c.kickoffUtc),league:requiredText(c.league),home:requiredText(c.home),away:requiredText(c.away)},missing=Object.entries(fields).filter(([,value])=>!value).map(([name])=>name);if(missing.length){invalid.push({scope:'candidate-validation',candidateIndex:index,goalFixtureId:fields.fixtureId??null,kind:'validation_error',error:`missing required candidate context: ${missing.join(', ')}`});continue}if(map.has(fields.fixtureId!))continue;map.set(fields.fixtureId!,{goal:{id:fields.fixtureId!,kickoffUtc:fields.kickoffUtc!,league:fields.league!,country:requiredText(c.country)??undefined,home:{id:requiredText(c.homeTeamId)??'',name:fields.home!},away:{id:requiredText(c.awayTeamId)??'',name:fields.away!}}})}return{targets:[...map.values()],invalid}}
function apiContext(value:any):FixtureContext|null{const fixture=value?.fixture,league=value?.league,home=value?.teams?.home,away=value?.teams?.away;if(!fixture?.id||!fixture?.date||!league?.name||!home?.id||!home?.name||!away?.id||!away?.name)return null;return{id:String(fixture.id),kickoffUtc:String(fixture.date),league:String(league.name),country:league.country?String(league.country):undefined,home:{id:String(home.id),name:String(home.name)},away:{id:String(away.id),name:String(away.name)}}}

export async function POST(request:Request){
  let apiRequests=0;
  try {
    const key=process.env.API_FOOTBALL_KEY;if(!key)return Response.json({ok:false,error:'API_FOOTBALL_KEYが未設定です',apiRequests:0},{status:500});
    const body=await request.json().catch(()=>null);const inputCandidates=Array.isArray(body?.candidates)?body.candidates as Candidate[]:[];const parsedTargets=targets(inputCandidates),list=parsedTargets.targets;if(!inputCandidates.length)return Response.json({ok:false,error:'候補試合がありません',apiRequests:0},{status:400});if(!list.length)return Response.json({ok:false,error:'候補試合の必須contextが不足しています',stage:'candidate-validation',apiRequests:0,failures:parsedTargets.invalid},{status:400});if(list.length>40)return Response.json({ok:false,error:'一度に取得できる候補は40試合までです',apiRequests:0},{status:400});
    let lastRequest=0;
    const requestApi=async(endpoint:string,params:Record<string,string>)=>{
      const wait=6500-(Date.now()-lastRequest);if(wait>0)await new Promise(resolve=>setTimeout(resolve,wait));
      try {
        const response=await fetch(`${BASE}${endpoint}?${new URLSearchParams(params)}`,{headers:{'x-apisports-key':key},cache:'no-store'});
        apiRequests++;lastRequest=Date.now();
        return await parseApiFootballResponse(response,endpoint);
      } catch (error) {
        lastRequest=Date.now();
        if (error instanceof ApiFootballResponseError) throw error;
        throw new ApiFootballResponseError(apiFootballFailure(error,endpoint));
      }
    };
    const fixtureResponses:any[]=[...parsedTargets.invalid.map(error=>({error}))];const fixtures:any[]=[];const failures:any[]=[...parsedTargets.invalid];let haltForRateLimit=false;
    for(const date of [...new Set(list.map(t=>jstDate(t.goal.kickoffUtc)))]){
      try {const payload=await requestApi('/fixtures',{date,timezone:'Asia/Tokyo'});fixtureResponses.push({date,payload});fixtures.push(...((payload as any).response??[]));}
      catch(error){const failure=apiFootballFailure(error,'/fixtures');failures.push({scope:'fixture-list',date,...failure});fixtureResponses.push({date,error:failure});if(failure.status===429){haltForRateLimit=true;break}}
    }
    const db=(env as unknown as{DB:D1Database}).DB;await ensureRuntimeSchema(db);const matched:Array<{target:Target;fixture:any;raw:any;safeContext:FixtureContext|null}>=[];const unmatched=[];
    for(const target of list){
      if(haltForRateLimit){unmatched.push(target);continue}
      let candidates:Array<{fixture:any;context:FixtureContext}>=[];let safe:Array<{fixture:any;context:FixtureContext}>=[];try{candidates=fixtures.map(f=>({fixture:f,context:apiContext(f)})).filter((pair):pair is {fixture:any;context:FixtureContext}=>!!pair.context&&sameName(target.goal.home.name,pair.context.home.name)&&sameName(target.goal.away.name,pair.context.away.name));safe=candidates.filter(pair=>matchFixturePair(target.goal,pair.context).status==='SAFE_MATCH')}catch(error){failures.push({scope:'fixture-validation',goalFixtureId:target.goal.id,kind:'internal_error',error:error instanceof Error?error.message:'fixture validation failed'});unmatched.push(target);continue}const chosen=safe.length===1?safe[0].fixture:candidates[0]?.fixture;if(!chosen){unmatched.push(target);continue}
      try {const raw=await requestApi('/odds',{fixture:String(chosen.fixture.id)});matched.push({target,fixture:chosen,raw,safeContext:safe.length===1?safe[0].context:null});}
      catch(error){const failure=apiFootballFailure(error,'/odds');failures.push({scope:'fixture-odds',goalFixtureId:target.goal.id,apiFixtureId:String(chosen.fixture.id),...failure});unmatched.push(target);if(failure.status===429)haltForRateLimit=true}
    }
    const createdAt=new Date().toISOString(),runId=`${createdAt}-${crypto.randomUUID()}`;
    // Persist all completed raw work before bridge/typed conversion; `fixtureResponses` also retains failed API diagnostics.
    await db.prepare(`INSERT INTO odds_analysis_runs (run_id,form_run_id,created_at,api_requests,matched_fixtures,unmatched_json,fixtures_json) VALUES (?,?,?,?,?,?,?)`).bind(runId,body?.formRunId??null,createdAt,apiRequests,matched.length,JSON.stringify(unmatched),JSON.stringify(fixtureResponses)).run();
    if(matched.length){const insert=db.prepare(`INSERT INTO odds_snapshots (run_id,api_fixture_id,kickoff,home,away,raw_json) VALUES (?,?,?,?,?,?)`);await db.batch(matched.map(item=>insert.bind(runId,String(item.fixture.fixture.id),item.fixture.fixture.date,item.fixture.teams.home.name,item.fixture.teams.away.name,JSON.stringify(item.raw))))}
    const identity={saved:0,noop:0,skipped:0,conflict:0};const typedSources:Array<{apiFixtureId:string;coreFixtureId:string;raw:unknown}>=[];
    for(const item of matched){if(!item.safeContext){identity.skipped+=1;continue}try{const result=await saveSafeFixtureIdentity(db,item.target.goal,item.safeContext);identity[result.status]+=1;if(result.status==='saved'||result.status==='noop')typedSources.push({apiFixtureId:String(item.fixture.fixture.id),coreFixtureId:result.coreFixtureId,raw:item.raw})}catch(error){identity.conflict+=1;console.error('fixture identity dual-write failed; raw odds remains saved',error)}}
    let typed={saved:0,existing:0,skipped:0,error:0,captureRuns:0,markets:0,unsupported:0,malformed:0};
    try{typed=await saveTypedOdds(db,{legacyRunId:runId,capturedAt:createdAt,apiRequests,sources:typedSources,raw:{format:'candidate-odds-dual-write-v1',matched:typedSources.map(source=>({apiFixtureId:source.apiFixtureId,coreFixtureId:source.coreFixtureId})),failures}})}catch(error){typed.error=1;console.error('typed odds dual-write failed; raw odds remains saved',error)}
    return Response.json({ok:true,runId,saved:true,partial:failures.length>0,apiRequests,matched:matched.length,unmatched,identity,typed,failures,haltedForRateLimit:haltForRateLimit});
  } catch (error) {
    const failure=internalApiFootballFailure(error,'/candidate-odds');
    const status=failure.status && failure.status>=400 ? failure.status : 500;
    console.error('candidate odds route failed', { name:error instanceof Error?error.name:'Error', message:failure.error, stack:error instanceof Error?error.stack:undefined, apiRequests });
    return Response.json({...publicApiFootballFailure(failure),apiRequests},{status});
  }
}
