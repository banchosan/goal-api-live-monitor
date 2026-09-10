export type FixtureContext={id:string;kickoffUtc:string;league:string;country?:string;home:{id:string;name:string};away:{id:string;name:string}};
export type BridgeResult={status:'SAFE_MATCH'|'POSSIBLE_MATCH'|'AMBIGUOUS'|'NO_MATCH';evidence:string[];reason:string};
const n=(v:string)=>v.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]/g,'');
export function matchFixturePair(goal:FixtureContext,api:FixtureContext):BridgeResult{
 const evidence:string[]=[];const diff=Math.abs(Date.parse(goal.kickoffUtc)-Date.parse(api.kickoffUtc));if(!Number.isFinite(diff))return{status:'NO_MATCH',evidence,reason:'invalid kickoff'};
 if(diff>5*60_000)return{status:'NO_MATCH',evidence,reason:'kickoff differs by over five minutes'};evidence.push(diff===0?'kickoff exact':'kickoff within five minutes');
 const home=n(goal.home.name)===n(api.home.name),away=n(goal.away.name)===n(api.away.name);if(!home||!away)return{status:'NO_MATCH',evidence,reason:'home/away pair differs'};evidence.push('home pair','away pair','orientation');
 if(n(goal.league)!==n(api.league))return{status:'POSSIBLE_MATCH',evidence,reason:'team pair and kickoff match but league differs'};evidence.push('league');if(goal.country&&api.country&&n(goal.country)!==n(api.country))return{status:'POSSIBLE_MATCH',evidence,reason:'team pair and kickoff match but country differs'};if(goal.country&&api.country)evidence.push('country');return{status:'SAFE_MATCH',evidence,reason:'independent fixture evidence agrees'};
}
