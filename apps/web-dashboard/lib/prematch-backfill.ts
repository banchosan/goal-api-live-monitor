export type SkipReason='UNSUPPORTED_MARKET'|'MALFORMED_ODDS'|'MISSING_FIXTURE'|'AMBIGUOUS_FIXTURE'|'DUPLICATE_CANDIDATE';
export type OddsCandidate={fixtureId:string;capturedAt:string;bookmaker:string;marketType:'MONEYLINE'|'ASIAN_HANDICAP'|'OVER_UNDER';side:'HOME'|'AWAY'|'DRAW'|'OVER'|'UNDER';line:number|null;odds:number;rawMarketName:string;rawSelectionName:string;raw:unknown};
export type Normalized={candidates:OddsCandidate[];skipped:Record<SkipReason,number>};
const empty=():Record<SkipReason,number>=>({UNSUPPORTED_MARKET:0,MALFORMED_ODDS:0,MISSING_FIXTURE:0,AMBIGUOUS_FIXTURE:0,DUPLICATE_CANDIDATE:0});
function line(text:string){const m=text.replace(',', '.').match(/([+-]?\d+(?:\.\d+)?)/);return m?Number(m[1]):null}
function side(value:string):OddsCandidate['side']|null{const v=value.trim().toLowerCase();if(v==='1'||v==='home'||v.startsWith('home '))return'HOME';if(v==='2'||v==='away'||v.startsWith('away '))return'AWAY';if(['draw','x'].includes(v))return'DRAW';if(v.startsWith('over'))return'OVER';if(v.startsWith('under'))return'UNDER';return null}
export function normalizeOdds(fixtureId:string|undefined,capturedAt:string|undefined,raw:unknown):Normalized{
 const result:Normalized={candidates:[],skipped:empty()};if(!fixtureId||!capturedAt){result.skipped.MISSING_FIXTURE++;return result}
 const seen=new Set<string>();const root=raw as any;
 for(const response of root?.response??[])for(const book of response?.bookmakers??[])for(const bet of book?.bets??[]){
  const market=String(bet?.name??''),lower=market.toLowerCase();const type=lower.includes('asian handicap')?'ASIAN_HANDICAP':(/^(match winner|1x2|winner)$/i.test(market)?'MONEYLINE':(lower.includes('over/under')||lower.includes('goals over/under'))?'OVER_UNDER':null);
  for(const value of bet?.values??[]){const selection=String(value?.value??''),odds=Number(value?.odd),s=side(selection);const l=type==='MONEYLINE'?null:line(selection);if(!type){result.skipped.UNSUPPORTED_MARKET++;continue}if(!Number.isFinite(odds)||!s||(type!=='MONEYLINE'&&l===null)){result.skipped.MALFORMED_ODDS++;continue}
   const row={fixtureId,capturedAt,bookmaker:String(book?.name??''),marketType:type,side:s,line:l,odds,rawMarketName:market,rawSelectionName:selection,raw:value} as OddsCandidate;if(!row.bookmaker){result.skipped.MALFORMED_ODDS++;continue};const key=[fixtureId,capturedAt,row.bookmaker,type,s,l,odds].join('|');if(seen.has(key)){result.skipped.DUPLICATE_CANDIDATE++;continue}seen.add(key);result.candidates.push(row)
  }
 }
 return result;
}

/** No fuzzy team-name linking: only explicit provider fixture identity resolves. */
export function mapFixture(provider:string,id:string,existing:Map<string,string>){const key=`${provider}:${id}`;return existing.has(key)?{fixtureId:existing.get(key)!,reason:'explicit_mapping'}:{fixtureId:null,reason:'UNRESOLVED_FIXTURE'} as const}
