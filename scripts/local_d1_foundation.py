#!/usr/bin/env python3
"""Local-only schema fingerprint, reconciliation and adoption runner.

It never uses network/Cloudflare.  `adopt` validates first; it only rebuilds
live_snapshots when every old source_event_id maps to a unique client_event_id.
"""
from __future__ import annotations
import argparse, hashlib, json, re, sqlite3, tempfile
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
SCHEMA=ROOT/'apps/web-dashboard/db/schema.ts'
INTERNAL={'sqlite_sequence','d1_migrations','_cf_METADATA'}
STAMP='0006_live_da_signal.sql'
LIVE_SNAPSHOT_PROJECTION_COLUMNS={
 'provider','provider_fixture_id','provider_event_key','added_time','match_status',
 'attacks_home','attacks_away','yellow_cards_home','yellow_cards_away','red_cards_home','red_cards_away',
 'saves_home','saves_away','passes_total_home','passes_total_away','passes_accurate_home','passes_accurate_away'
}

def stmts():
 text=SCHEMA.read_text(); a=re.findall(r'`([^`]+)`',text)+re.findall(r"'(CREATE (?:UNIQUE )?INDEX[^']+)'",text)
 return [x.strip() for x in a if x.strip().upper().startswith('CREATE')]

def create(c):
 for sql in stmts(): c.execute(sql)
 # metadata used to be request-time ALTERs; clean canonical DB gets them here.
 for n,t in [('client_event_id','TEXT'),('connection_id','TEXT'),('sequence','INTEGER'),('source',"TEXT NOT NULL DEFAULT 'browser'"),('provider_timestamp','TEXT'),('payload_hash','TEXT'),('schema_version','INTEGER NOT NULL DEFAULT 1')]:
  try:c.execute(f'ALTER TABLE monitor_events ADD COLUMN {n} {t}')
  except sqlite3.OperationalError:pass
 c.execute("CREATE UNIQUE INDEX IF NOT EXISTS monitor_events_client_event_idx ON monitor_events(client_event_id) WHERE client_event_id IS NOT NULL")
 c.commit()

def q(s):return '"'+s.replace('"','""')+'"'
def model(c):
 out={}
 for (t,) in c.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"):
  if t in INTERNAL or t.startswith('sqlite_'):continue
  cols=[{'name':x[1],'type':(x[2]or'').upper(),'notnull':bool(x[3]),'default':x[4],'pk':x[5]} for x in c.execute(f'PRAGMA table_info({q(t)})')]
  all_idx=list(c.execute(f'PRAGMA index_list({q(t)})'))
  implicit={tuple(r[2] for r in c.execute(f'PRAGMA index_info({q(x[1])})')) for x in all_idx if x[1].startswith('sqlite_autoindex') and x[2]}
  idx=[]
  for x in all_idx:
   members=[r[2] for r in c.execute(f'PRAGMA index_info({q(x[1])})')]
   # A historical explicit unique index which exactly duplicates a table
   # UNIQUE constraint has no schema meaning; tolerate it during adoption.
   if not x[1].startswith('sqlite_autoindex') and not (x[2] and tuple(members) in implicit):idx.append({'unique':bool(x[2]),'columns':members})
  out[t]={'columns':cols,'indexes':sorted(idx,key=lambda x:json.dumps(x,sort_keys=True))}
 return out
def fp(c):return 'sha256:'+hashlib.sha256(json.dumps(model(c),sort_keys=True,separators=(',',':')).encode()).hexdigest()
def expected():
 c=sqlite3.connect(':memory:');create(c);return model(c)
def diff(actual,want):
 r=[]
 for t in sorted(set(actual)|set(want)):
  if t not in actual:r.append(f'MISSING TABLE {t}');continue
  if t not in want:r.append(f'UNEXPECTED TABLE {t}');continue
  a={x['name']:x for x in actual[t]['columns']};w={x['name']:x for x in want[t]['columns']}
  for x in sorted(set(w)-set(a)):r.append(f'{t}: MISSING COLUMN {x}')
  for x in sorted(set(a)-set(w)):r.append(f'{t}: UNEXPECTED COLUMN {x}')
  for x in sorted(set(a)&set(w)):
   if a[x]!=w[x]:r.append(f'{t}: INCOMPATIBLE COLUMN {x}: expected={w[x]} actual={a[x]}')
  ai={(x['unique'],tuple(x['columns'])) for x in actual[t]['indexes']};wi={(x['unique'],tuple(x['columns'])) for x in want[t]['indexes']}
  for x in wi-ai:r.append(f'{t}: MISSING INDEX {x}')
  for x in ai-wi:r.append(f'{t}: UNEXPECTED INDEX {x}')
 return r

def legacy(c):
 c.execute('DROP TABLE IF EXISTS live_snapshots')
 c.execute('''CREATE TABLE live_snapshots(id INTEGER PRIMARY KEY AUTOINCREMENT,fixture_id TEXT NOT NULL,session_id TEXT NOT NULL,source_event_id INTEGER REFERENCES monitor_events(id),provider_timestamp TEXT,captured_at TEXT NOT NULL,elapsed_minute INTEGER,home_score INTEGER,away_score INTEGER,shots_home REAL,shots_away REAL,shots_on_target_home REAL,shots_on_target_away REAL,corners_home REAL,corners_away REAL,dangerous_attacks_home REAL,dangerous_attacks_away REAL,possession_home REAL,possession_away REAL,xg_home REAL,xg_away REAL,raw_statistics_json TEXT NOT NULL,UNIQUE(session_id,source_event_id))''')
 c.execute('CREATE INDEX live_snapshots_fixture_time_idx ON live_snapshots(fixture_id,captured_at)');c.execute('CREATE INDEX live_snapshots_fixture_minute_idx ON live_snapshots(fixture_id,elapsed_minute)');c.commit()
def summary(c,t='live_snapshots'):
 return c.execute(f'SELECT COUNT(*),COUNT(DISTINCT session_id),SUM(captured_at IS NULL),MIN(captured_at),MAX(captured_at) FROM {q(t)}').fetchone()
def validate(c):
 names={x[1] for x in c.execute('PRAGMA table_info(live_snapshots)')}
 if 'source_client_event_id' in names:return 'modern'
 if 'source_event_id' not in names:raise RuntimeError('UNKNOWN_SCHEMA')
 bad=c.execute('''SELECT COUNT(*) FROM live_snapshots l LEFT JOIN monitor_events m ON m.id=l.source_event_id WHERE l.source_event_id IS NULL OR m.id IS NULL OR m.client_event_id IS NULL''').fetchone()[0]
 dup=c.execute('''SELECT COUNT(*) FROM(SELECT l.session_id,m.client_event_id,COUNT(*) n FROM live_snapshots l JOIN monitor_events m ON m.id=l.source_event_id GROUP BY l.session_id,m.client_event_id HAVING n>1)''').fetchone()[0]
 if bad:raise RuntimeError(f'BLOCKED_NULL_OR_UNMATCHED_ROWS:{bad}')
 if dup:raise RuntimeError(f'BLOCKED_DUPLICATES:{dup}')
 return 'legacy'
def snapshot_columns(c, table):
 return [x[1] for x in c.execute(f'PRAGMA table_info({q(table)})')]
def rebuild_live_snapshots(c, old_table, source_mode):
 before=summary(c);c.execute('ALTER TABLE live_snapshots RENAME TO live_snapshots__legacy')
 # SQLite retains explicit index names after table rename.  Drop them before
 # creating the replacement table so the canonical index creation is reliable.
 c.execute('DROP INDEX IF EXISTS live_snapshots_fixture_time_idx');c.execute('DROP INDEX IF EXISTS live_snapshots_fixture_minute_idx')
 sql=next(x for x in stmts() if x.startswith('CREATE TABLE IF NOT EXISTS live_snapshots'));c.execute(sql)
 old=set(snapshot_columns(c,'live_snapshots__legacy')); target=[x for x in snapshot_columns(c,'live_snapshots') if x!='id']
 select=[]
 for name in target:
  if name=='source_client_event_id':select.append('m.client_event_id' if source_mode=='legacy' else 'l.source_client_event_id')
  elif name=='provider':select.append("COALESCE(l.provider,'goal-api')" if name in old else "'goal-api'")
  elif name=='provider_event_key':select.append("COALESCE(NULLIF(l.provider_event_key,''),l.source_client_event_id)" if name in old else ('m.client_event_id' if source_mode=='legacy' else 'l.source_client_event_id'))
  elif name in old:select.append(f'l.{q(name)}')
  else:select.append('NULL')
 join=' JOIN monitor_events m ON m.id=l.source_event_id' if source_mode=='legacy' else ''
 c.execute(f'INSERT INTO live_snapshots({",".join(q(x) for x in target)}) SELECT {",".join(select)} FROM live_snapshots__legacy l{join}')
 if summary(c)!=before:raise RuntimeError(f'INTEGRITY_MISMATCH:{before}!={summary(c)}')
 c.execute('DROP TABLE live_snapshots__legacy')
 for s in stmts():
  if s.startswith('CREATE INDEX') and 'live_snapshots_' in s:c.execute(s)
 c.commit();return True
def reconcile(c):
 mode=validate(c)
 if mode=='legacy':return rebuild_live_snapshots(c,'live_snapshots__legacy','legacy')
 current=set(snapshot_columns(c,'live_snapshots'))
 if LIVE_SNAPSHOT_PROJECTION_COLUMNS-current:return rebuild_live_snapshots(c,'live_snapshots__legacy','modern')
 return False
def reconcile_live_signals(c):
 names={x[1] for x in c.execute('PRAGMA table_info(live_signals)')}
 if 'signal_key' not in names:c.execute('ALTER TABLE live_signals ADD COLUMN signal_key TEXT')
 c.execute('CREATE UNIQUE INDEX IF NOT EXISTS live_signals_rule_side_dedupe_idx ON live_signals (fixture_id, signal_type, signal_version, signal_key) WHERE signal_key IS NOT NULL')
def adopt(path):
 c=sqlite3.connect(path);before=fp(c);rebuilt=reconcile(c);reconcile_live_signals(c)
 c.execute('CREATE TABLE IF NOT EXISTS d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL UNIQUE,applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)');c.execute('INSERT OR IGNORE INTO d1_migrations(name) VALUES(?)',(STAMP,));c.commit()
 problems=diff(model(c),expected())
 if problems:raise RuntimeError('ADOPTION_SCHEMA_MISMATCH\n'+'\n'.join(problems))
 return {'before':before,'after':fp(c),'rebuilt':rebuilt,'integrity':summary(c)}

def fixture(p,kind):
 c=sqlite3.connect(p);create(c);legacy(c);c.execute('CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL UNIQUE,applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)');c.execute("INSERT INTO d1_migrations(name) VALUES('0000_legacy_baseline.sql')")
 if kind!='zero':
  c.execute("INSERT INTO monitor_events(session_id,fixture_id,event_type,received_at,payload_json,client_event_id)VALUES('s','f','match_update','2026-01-01T00:00:00Z','{}','event-1')");c.execute("INSERT INTO live_snapshots(fixture_id,session_id,source_event_id,captured_at,raw_statistics_json)VALUES('f','s',1,'2026-01-01T00:00:00Z','[]')")
  if kind=='null':c.execute('UPDATE monitor_events SET client_event_id=NULL')
  if kind=='unmatched':c.execute('UPDATE live_snapshots SET source_event_id=99')
  if kind=='duplicate':
   # Old/bootstrap-only DBs may not have had the later unique metadata index.
   c.execute('DROP INDEX monitor_events_client_event_idx')
   c.execute("INSERT INTO monitor_events(session_id,fixture_id,event_type,received_at,payload_json,client_event_id)VALUES('s','f','match_update','2026-01-01T00:01:00Z','{}','event-1')");c.execute("INSERT INTO live_snapshots(fixture_id,session_id,source_event_id,captured_at,raw_statistics_json)VALUES('f','s',2,'2026-01-01T00:01:00Z','[]')")
 c.commit();return c
def modern_pre_projection_fixture(p):
 c=sqlite3.connect(p);create(c);c.execute('DROP TABLE live_snapshots')
 c.execute('''CREATE TABLE live_snapshots(id INTEGER PRIMARY KEY AUTOINCREMENT,fixture_id TEXT NOT NULL,session_id TEXT NOT NULL,source_client_event_id TEXT NOT NULL,provider_timestamp TEXT,captured_at TEXT NOT NULL,elapsed_minute INTEGER,home_score INTEGER,away_score INTEGER,shots_home REAL,shots_away REAL,shots_on_target_home REAL,shots_on_target_away REAL,corners_home REAL,corners_away REAL,dangerous_attacks_home REAL,dangerous_attacks_away REAL,possession_home REAL,possession_away REAL,xg_home REAL,xg_away REAL,raw_statistics_json TEXT NOT NULL,UNIQUE(session_id,source_client_event_id))''')
 c.execute('CREATE INDEX live_snapshots_fixture_time_idx ON live_snapshots(fixture_id,captured_at)');c.execute('CREATE INDEX live_snapshots_fixture_minute_idx ON live_snapshots(fixture_id,elapsed_minute)')
 c.execute("INSERT INTO core_fixtures(id,home_name,away_name,created_at,updated_at) VALUES('f','Home','Away','2026-01-01','2026-01-01')")
 c.execute("INSERT INTO live_snapshots(fixture_id,session_id,source_client_event_id,captured_at,raw_statistics_json) VALUES('f','s','event-1','2026-01-01T00:00:00Z','[]')")
 c.commit();return c
def tests():
 with tempfile.TemporaryDirectory() as d:
  d=Path(d);c=sqlite3.connect(d/'clean.db');create(c);clean=fp(c)
  results={}
  for k in ('zero','valid'):
   fixture(d/f'{k}.db',k);results[k]=adopt(d/f'{k}.db');assert results[k]['after']==clean
  modern_pre_projection_fixture(d/'modern.db');results['modern']=adopt(d/'modern.db');assert results['modern']['after']==clean
  for k,tag in [('null','BLOCKED_NULL_OR_UNMATCHED_ROWS'),('unmatched','BLOCKED_NULL_OR_UNMATCHED_ROWS'),('duplicate','BLOCKED_DUPLICATES')]:
   fixture(d/f'{k}.db',k)
   try:adopt(d/f'{k}.db');raise AssertionError(k)
   except RuntimeError as e:assert str(e).startswith(tag),e
  return {'tests':6,'clean':clean,'adopted':results['valid']['after'],'equal':True}
def emit(path):
 path.parent.mkdir(parents=True,exist_ok=True);path.write_text('-- Generated from apps/web-dashboard/db/schema.ts. Do not hand edit.\nBEGIN;\n'+'\n'.join(x+';' for x in stmts())+'\nCOMMIT;\n')
def main():
 p=argparse.ArgumentParser();s=p.add_subparsers(dest='cmd',required=True)
 for k in ('fingerprint','verify','adopt'):s.add_parser(k).add_argument('db',type=Path)
 s.add_parser('test');s.add_parser('emit-migration').add_argument('db',type=Path);a=p.parse_args()
 if a.cmd=='test':print(json.dumps(tests(),indent=2));return
 if a.cmd=='emit-migration':emit(a.db);return
 c=sqlite3.connect(f'file:{a.db}?mode=ro',uri=True) if a.cmd!='adopt' else None
 if a.cmd=='fingerprint':print(fp(c));return
 if a.cmd=='verify':
  x=diff(model(c),expected());print('MATCH' if not x else '\n'.join(x));raise SystemExit(bool(x))
 print(json.dumps(adopt(a.db),indent=2))
if __name__=='__main__':main()
