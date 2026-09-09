#!/usr/bin/env python3
"""Read-only PRE-MATCH source inventory. Never opens the database writable."""
import argparse,json,sqlite3
from pathlib import Path
TABLES=['form_analysis_runs','odds_analysis_runs','odds_snapshots','result_snapshots','match_results_v2','core_fixtures','fixture_provider_ids']
def main():
 p=argparse.ArgumentParser();p.add_argument('database',type=Path);p.add_argument('--report',type=Path);a=p.parse_args()
 c=sqlite3.connect(f'file:{a.database}?mode=ro',uri=True)
 out={'mode':'DRY_RUN_READ_ONLY','sources':{},'conversion':{'fixture_mapping_policy':'explicit provider mapping only; no team-name auto-link'},'writes':0}
 for t in TABLES:
  try:
   cols=[x[1] for x in c.execute(f'PRAGMA table_info("{t}")')];n=c.execute(f'SELECT COUNT(*) FROM "{t}"').fetchone()[0]
   out['sources'][t]={'rows':n,'columns':cols,'json_columns':[x for x in cols if x.endswith('_json') or x=='raw_json']}
  except sqlite3.OperationalError:out['sources'][t]={'missing':True}
 text=json.dumps(out,indent=2);print(text)
 if a.report:a.report.write_text(text+'\n')
if __name__=='__main__':main()
