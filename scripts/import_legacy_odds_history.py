#!/usr/bin/env python3
"""Import the 2026-09-03 saved pre-match snapshot into the local D1 DB. No API calls."""
import json, sqlite3
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
WEB=ROOT/'apps/web-dashboard'
HISTORY=ROOT/'data/history/2026-09-03_pre_match_shortlist'
RUN_ID='legacy-2026-09-03-pre-match-shortlist'
db_files=list((WEB/'.wrangler/state/v3/d1/miniflare-D1DatabaseObject').glob('*.sqlite'))
db_file=next((p for p in db_files if p.name!='metadata.sqlite'),None)
if not db_file: raise SystemExit('D1 database file not found')
form=json.loads((HISTORY/'form_candidates.json').read_text())
odds=json.loads((HISTORY/'odds/odds_results_raw.json').read_text())
additional=json.loads((HISTORY/'odds/additional_odds_raw.json').read_text())
display=json.loads((WEB/'public/odds-data.json').read_text())
display_by_id={str(m['fixtureId']):m for m in display['matches']}
matched=[]
fixtures=[]
for item in odds.get('matched',[]):
    fixture=item['fixture'];raw=item['odds'];fid=str(fixture['fixture']['id'])
    matched.append((fid,fixture['fixture']['date'],fixture['teams']['home']['name'],fixture['teams']['away']['name'],raw));fixtures.append(fixture)
for item in additional:
    raw=item['body'];fid=str(item['fixture_id']);meta=display_by_id.get(fid,{})
    response=(raw.get('response') or [{}])[0];fixtures.append({'fixture':response.get('fixture',{}),'league':response.get('league',{}),'teams':{'home':{'name':meta.get('home','Home')},'away':{'name':meta.get('away','Away')}}})
    matched.append((fid,meta.get('kickoff') or response.get('fixture',{}).get('date'),meta.get('home','Home'),meta.get('away','Away'),raw))
created=display.get('fetchedAt') or odds.get('fetched_at_utc')
con=sqlite3.connect(db_file)
con.execute('CREATE TABLE IF NOT EXISTS result_snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, odds_run_id TEXT NOT NULL, created_at TEXT NOT NULL, api_requests INTEGER NOT NULL, raw_json TEXT NOT NULL, UNIQUE(odds_run_id, created_at))')
con.execute('INSERT OR IGNORE INTO form_analysis_runs (run_id,created_at,checked_teams,failed_teams,api_requests,candidates_json,checked_json) VALUES (?,?,?,?,?,?,?)',(RUN_ID+'-form',created,0,0,0,json.dumps(form.get('candidates',[]),ensure_ascii=False),'[]'))
con.execute('INSERT OR IGNORE INTO odds_analysis_runs (run_id,form_run_id,created_at,api_requests,matched_fixtures,unmatched_json,fixtures_json) VALUES (?,?,?,?,?,?,?)',(RUN_ID,RUN_ID+'-form',created,odds.get('request_count',17),len(matched),json.dumps(display.get('unmatched',[]),ensure_ascii=False),json.dumps([{'date':'2026-09-03','payload':{'response':fixtures}}],ensure_ascii=False)))
if not con.execute('SELECT 1 FROM odds_snapshots WHERE run_id=? LIMIT 1',(RUN_ID,)).fetchone():
    con.executemany('INSERT INTO odds_snapshots (run_id,api_fixture_id,kickoff,home,away,raw_json) VALUES (?,?,?,?,?,?)',[(RUN_ID,fid,kickoff,home,away,json.dumps(raw,ensure_ascii=False)) for fid,kickoff,home,away,raw in matched])
con.commit()
postmatch_file=HISTORY/'postmatch/fixtures_final_raw.json'
if postmatch_file.exists():
    result_raw=json.loads(postmatch_file.read_text())
    if not con.execute('SELECT 1 FROM result_snapshots WHERE odds_run_id=? LIMIT 1',(RUN_ID,)).fetchone():
        con.execute('INSERT INTO result_snapshots (odds_run_id,created_at,api_requests,raw_json) VALUES (?,?,?,?)',(RUN_ID,'2026-09-04T06:00:00.000Z',0,json.dumps([{'date':'saved-postmatch','response':result_raw.get('response',[])}],ensure_ascii=False)))
        con.commit()
print(json.dumps({'importedRun':RUN_ID,'matches':len(matched),'database':str(db_file)},ensure_ascii=False))
