#!/usr/bin/env python3
"""
Analyze betting rules using saved local data.

This is a port of /Users/tsukasa/Documents/ChatGPT/try/analyze_betting_rules.py
with absolute paths removed and basic CLI arguments.

Usage:
  python3 scripts/analyze_betting_rules.py --date 2026-09-03

The script reads data from the repository `data/history/<date>_pre_match_shortlist`
and writes output to `data/api_football_odds/<date>_postmatch/analysis_summary.json` by default.
"""
from pathlib import Path
import json
import re
import unicodedata
import os
import argparse


def norm(s):
    s = ''.join(c for c in unicodedata.normalize('NFKD', s or '') if not unicodedata.combining(c)).lower()
    s = s.replace('ı', 'i').replace('qadisiyah', 'qadsiah')
    s = re.sub(r'[^a-z0-9]+', ' ', s)
    return re.sub(r'\b(fc|fk|sc|cf|as|jk|club|f k)\b', ' ', s).strip()


def similar(a, b):
    x, y = norm(a), norm(b)
    if x == y or x in y or y in x:
        return True
    xs = {v for v in x.split() if len(v) > 2}
    ys = {v for v in y.split() if len(v) > 2}
    return len(xs & ys) >= min(2, len(xs), len(ys))


def stat_pair(fid, name, stats):
    response = stats.get(str(fid), {}).get('response', [])
    vals = []
    for team in response:
        found = next((x.get('value') for x in team.get('statistics', []) if x.get('type') == name), None)
        try:
            found = float(str(found).replace('%', ''))
        except Exception:
            found = None
        vals.append(found)
    return (vals + [None, None])[:2]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--date', default='2026-09-03', help='Target date (YYYY-MM-DD)')
    parser.add_argument('--bookmaker', default=os.getenv('BOOKMAKER'), help='Bookmaker name (optional)')
    parser.add_argument('--repo-root', default=Path(__file__).resolve().parents[1], help='Repository root')
    parser.add_argument('--input-root', default=None, help='Input root (overrides repo-root/data)')
    parser.add_argument('--output-root', default=None, help='Output root (overrides repo-root/data)')
    args = parser.parse_args()

    repo_root = Path(args.repo_root)
    input_root = Path(args.input_root) if args.input_root else repo_root / 'data'
    output_root = Path(args.output_root) if args.output_root else repo_root / 'data'

    date = args.date
    bookmaker = args.bookmaker

    pre_dir = input_root / 'history' / f"{date}_pre_match_shortlist"
    # Determine postmatch folder: prefer existing 'history/<date>_pre_match_shortlist/postmatch'
    pre_post = input_root / 'history' / f"{date}_pre_match_shortlist" / 'postmatch'
    post_dir = pre_post if pre_post.exists() else (output_root / 'api_football_odds' / f"{date}_postmatch")
    out_file = post_dir / 'analysis_summary.json'

    if not pre_dir.exists():
        raise SystemExit(f"Input data directory not found: {pre_dir}")

    PRE = pre_dir
    POST = post_dir
    OUT = out_file
    # If a bookmaker is specified (via --bookmaker or BOOKMAKER env), match original filename behavior
    if bookmaker:
        OUT = POST / f"analysis_{str(bookmaker).lower()}.json"

    # load files
    forms = json.loads((PRE / 'form_candidates.json').read_text())['candidates']
    view = json.loads((PRE / 'odds' / 'odds-data.json').read_text())
    summary = json.loads((PRE / 'odds' / 'summary.json').read_text())
    extra = json.loads((PRE / 'odds' / 'additional_odds_raw.json').read_text())
    fixtures = json.loads((POST / 'fixtures_final_raw.json').read_text())['response'] if (POST / 'fixtures_final_raw.json').exists() else []
    stats = json.loads((POST / 'statistics_final_raw.json').read_text()) if (POST / 'statistics_final_raw.json').exists() else {}


    def markets_for(fid):
        item = next((m for m in summary.get('matches', []) if str(m.get('fixture_id')) == str(fid)), None)
        if item:
            return [m for m in item.get('markets', []) if not bookmaker or norm(m.get('bookmaker', '')) == norm(bookmaker)]
        item = next((x for x in extra if str(x.get('fixture_id')) == str(fid)), None)
        result = []
        for book in (item or {}).get('body', {}).get('response', [{}])[0].get('bookmakers', []):
            if bookmaker and norm(book.get('name', '')) != norm(bookmaker):
                continue
            for bet in book.get('bets', []):
                result.append({'bookmaker': book.get('name'), 'market': bet.get('name'), 'values': bet.get('values', [])})
        return result


    def best_prices(markets):
        out = {}
        for m in markets:
            for v in m['values']:
                try:
                    o = float(v.get('odd'))
                except Exception:
                    continue
                key = (m['market'], v.get('value'))
                if key not in out or (m.get('bookmaker') == '10Bet' and out[key].get('bookmaker') != '10Bet'):
                    out[key] = {'odd': o, 'bookmaker': m.get('bookmaker')}
        return out


    # reuse helper functions from original (total_profit, handicap_profit, settle)
    def total_profit(actual, line, over, odd):
        frac = round(line % 1, 2)
        lines = [line]
        if frac == .25:
            lines = [line - .25, line + .25]
        elif frac == .75:
            lines = [line - .25, line + .25]
        profit = 0
        for ln in lines:
            win = actual > ln if over else actual < ln
            push = actual == ln
            profit += (0 if push else odd - 1 if win else -1) / len(lines)
        return profit

    def handicap_profit(diff, line, side, odd):
        frac = round(abs(line) % 1, 2)
        lines = [line]
        if frac in (.25, .75):
            lines = [line - .25, line + .25]
        profit = 0
        for ln in lines:
            adjusted = diff + ln
            if side == 'Away':
                adjusted = -adjusted
            profit += (odd - 1 if adjusted > 0 else 0 if adjusted == 0 else -1) / len(lines)
        return profit

    def settle(market, value, odd, ctx):
        h, a, hh, ha = ctx['h'], ctx['a'], ctx['hh'], ctx['ha']
        total = h + a
        ht = hh + ha
        if market == 'Match Winner':
            return (odd - 1 if {'Home': h > a, 'Draw': h == a, 'Away': a > h}.get(value, False) else -1)
        if market == 'Both Teams Score':
            return odd - 1 if ((h > 0 and a > 0) == (value == 'Yes')) else -1
        if market == 'First Half Winner':
            return odd - 1 if {'Home': hh > ha, 'Draw': hh == ha, 'Away': ha > hh}.get(value, False) else -1
        if market == 'Exact Score':
            return odd - 1 if value in {f'{h}:{a}', f'{h}-{a}'} else -1
        if market == 'Odd/Even':
            return odd - 1 if ((total % 2 == 1) == (value == 'Odd')) else -1
        if market == 'Double Chance':
            ok = {'Home/Draw': h >= a, 'Home/Away': h != a, 'Draw/Away': a >= h}.get(value)
            return None if ok is None else odd - 1 if ok else -1
        for title, actual in [('Goals Over/Under', total), ('Goals Over/Under First Half', ht), ('Total - Home', h), ('Total - Away', a), ('Corners Over Under', ctx.get('corners'))]:
            if market == title and actual is not None:
                mt = re.match(r'(Over|Under) (\d+(?:\.\d+)?)$', value)
                if mt:
                    return total_profit(actual, float(mt.group(2)), mt.group(1) == 'Over', odd)
        for title, actual in [('Home Team Total Goals(1st Half)', hh), ('Away Team Total Goals(1st Half)', ha), ('Home Corners Over/Under', ctx.get('hc')), ('Away Corners Over/Under', ctx.get('ac'))]:
            if market == title and actual is not None:
                mt = re.match(r'(Over|Under) (\d+(?:\.\d+)?)$', value)
                if mt:
                    return total_profit(actual, float(mt.group(2)), mt.group(1) == 'Over', odd)
        if market in ('Asian Handicap', 'Asian Handicap First Half', 'Corners Asian Handicap'):
            mt = re.match(r'(Home|Away) ([+-]?\d+(?:\.\d+)?)$', value)
            if mt:
                diff = (h - a) if market == 'Asian Handicap' else (hh - ha) if market == 'Asian Handicap First Half' else (ctx.get('hc') - ctx.get('ac') if ctx.get('hc') is not None else None)
                if diff is not None:
                    return handicap_profit(diff, float(mt.group(2)), mt.group(1), odd)
        if market == 'Corners 1x2' and ctx.get('hc') is not None:
            hc, ac = ctx.get('hc'), ctx.get('ac')
            ok = {'Home': hc > ac, 'Draw': hc == ac, 'Away': ac > hc}.get(value)
            return None if ok is None else odd - 1 if ok else -1
        return None


    games = []
    for f in fixtures:
        # skip finished matches only
        if f.get('fixture', {}).get('status', {}).get('short') not in ('FT', 'AET', 'PEN'):
            continue
        fid = f['fixture']['id']
        h = f['goals']['home']
        a = f['goals']['away']
        hh = f['score']['halftime']['home']
        ha = f['score']['halftime']['away']
        hc, ac = stat_pair(fid, 'Corner Kicks', stats)
        markets = markets_for(fid)
        prices = best_prices(markets)
        if bookmaker and not markets:
            continue
        candidates = []
        for c in forms:
            actual = f['teams']['home']['name'] if c['side'] == 'home' else f['teams']['away']['name']
            opponent = f['teams']['away']['name'] if c['side'] == 'home' else f['teams']['home']['name']
            if similar(c['team'], actual) and similar(c['opponent'], opponent):
                candidates.append(c)
        games.append({'id': fid, 'home': f['teams']['home']['name'], 'away': f['teams']['away']['name'], 'score': f'{h}-{a}', 'ctx': {'h': h, 'a': a, 'hh': hh, 'ha': ha, 'hc': hc, 'ac': ac, 'corners': None if hc is None or ac is None else hc + ac}, 'prices': prices, 'candidates': candidates})

    def bet_result(game, side):
        key = ('Match Winner', side.title())
        price = game['prices'].get(key)
        if not price:
            return None
        return settle(*key, price['odd'], game['ctx']), price['odd']

    def summarize(name, bets):
        bets = [b for b in bets if b is not None]
        if not bets:
            return None
        profit = round(sum(b[0] for b in bets), 2)
        wins = sum(b[0] > 0 for b in bets)
        push = sum(b[0] == 0 for b in bets)
        return {'rule': name, 'bets': len(bets), 'wins': wins, 'pushes': push, 'profit_units': profit, 'roi_pct': round(100 * profit / len(bets), 1), 'avg_odds': round(sum(b[1] for b in bets) / len(bets), 2)}

    rules = []
    rules.append(summarize('市場最小オッズの本命を買う', [bet_result(g, min((('home', g['prices'].get(('Match Winner', 'Home'), {} ).get('odd', 99)), ('draw', g['prices'].get(('Match Winner', 'Draw'), {}).get('odd', 99)), ('away', g['prices'].get(('Match Winner', 'Away'), {}).get('odd', 99))), key=lambda x: x[1])[0]) for g in games]))
    favorite_candidates = []
    underdog_candidates = []
    both_candidate_favorite = []
    for g in games:
        favorite = min((('home', g['prices'].get(('Match Winner', 'Home'), {}).get('odd', 99)), ('draw', g['prices'].get(('Match Winner', 'Draw'), {}).get('odd', 99)), ('away', g['prices'].get(('Match Winner', 'Away'), {}).get('odd', 99))), key=lambda x: x[1])[0]
        for c in g['candidates']:
            (favorite_candidates if c['side'] == favorite else underdog_candidates).append(bet_result(g, c['side']))
        if len(g['candidates']) > 1:
            both_candidate_favorite.append(bet_result(g, favorite))
    rules.append(summarize('調子候補かつ市場本命→候補チーム勝利', favorite_candidates))
    rules.append(summarize('調子候補だが市場非本命→候補チーム勝利', underdog_candidates))
    rules.append(summarize('両チーム調子条件通過→市場本命の勝利', both_candidate_favorite))
    for threshold in (1.30, 1.50, 1.70, 2.00):
        bets = []
        for g in games:
            for c in g['candidates']:
                b = bet_result(g, c['side'])
                if b and b[1] <= threshold:
                    bets.append(b)
        rules.append(summarize(f'調子候補の勝利 オッズ<={threshold:.2f}', bets))
    for wins in (3, 4, 5):
        bets = []
        for g in games:
            for c in g['candidates']:
                if c['wins'] == wins:
                    bets.append(bet_result(g, c['side']))
        rules.append(summarize(f'調子候補の勝利 直近5戦{wins}勝', bets))
    for only_single in (False, True):
        bets = []
        for g in games:
            if only_single and len(g['candidates']) != 1:
                continue
            for c in g['candidates']:
                bets.append(bet_result(g, c['side']))
    rules.append(summarize('片側だけ調子条件通過→そのチーム勝利' if only_single else '全調子候補チーム勝利', bets))

    corner_over = []
    corner_under = []
    goals_over = []
    goals_under = []
    favorite_ah = []
    candidate_ah = []
    candidate_favorite_ah = []
    favorite_ah_details = []
    for g in games:
        def balanced_line(market):
            choices = []
            for (name, value), p in g['prices'].items():
                try:
                    value_str = str(value)
                except Exception:
                    value_str = ''
                mt = re.match(r'Over (\d+(?:\.\d+)?)$', value_str)
                if name != market or not mt:
                    continue
                under_key = (market, f"Under {mt.group(1)}")
                under = g['prices'].get(under_key)
                if under:
                    choices.append((abs(p['odd'] - under['odd']), float(mt.group(1)), p, under))
            return min(choices, key=lambda x: x[0]) if choices else None
        c = balanced_line('Corners Over Under')
        if c and g['ctx']['corners'] is not None:
            _, line, o, u = c
            corner_over.append((total_profit(g['ctx']['corners'], line, True, o['odd']), o['odd']))
            corner_under.append((total_profit(g['ctx']['corners'], line, False, u['odd']), u['odd']))
        t = balanced_line('Goals Over/Under')
        if t:
            _, line, o, u = t
            total = g['ctx']['h'] + g['ctx']['a']
            goals_over.append((total_profit(total, line, True, o['odd']), o['odd']))
            goals_under.append((total_profit(total, line, False, u['odd']), u['odd']))
        favorite = min((('home', g['prices'].get(('Match Winner', 'Home'), {}).get('odd', 99)), ('away', g['prices'].get(('Match Winner', 'Away'), {}).get('odd', 99))), key=lambda x: x[1])[0]
        options = []
        for (name, value), p in g['prices'].items():
            if name != 'Asian Handicap':
                continue
            try:
                value_str = str(value)
            except Exception:
                continue
            if value_str.startswith(favorite.title() + ' '):
                options.append((abs(p['odd'] - 1.9), value_str, p))
        if options:
            _, value, p = min(options, key=lambda x: x[0])
            profit = settle('Asian Handicap', value, p['odd'], g['ctx'])
            favorite_ah.append((profit, p['odd']))
            favorite_ah_details.append({'fixture_id': g['id'], 'match': f"{g['home']} vs {g['away']}", 'score': g['score'], 'selection': value, 'odd': p['odd'], 'profit': round(profit, 3)})
        for candidate in g['candidates']:
            options = []
            for (name, value), p in g['prices'].items():
                if name != 'Asian Handicap':
                    continue
                try:
                    value_str = str(value)
                except Exception:
                    continue
                if value_str.startswith(candidate['side'].title() + ' '):
                    options.append((abs(p['odd'] - 1.9), value_str, p))
            if options:
                _, value, p = min(options, key=lambda x: x[0])
                bet = (settle('Asian Handicap', value, p['odd'], g['ctx']), p['odd'])
                candidate_ah.append(bet)
                if candidate['side'] == favorite:
                    candidate_favorite_ah.append(bet)
    rules.append(summarize('各試合の主要コーナーライン OVER', corner_over))
    rules.append(summarize('各試合の主要コーナーライン UNDER', corner_under))
    rules.append(summarize('各試合の主要ゴールライン OVER', goals_over))
    rules.append(summarize('各試合の主要ゴールライン UNDER', goals_under))
    rules.append(summarize('市場本命側の主要Asian Handicap', favorite_ah))
    rules.append(summarize('調子候補側の主要Asian Handicap', candidate_ah))
    rules.append(summarize('調子候補かつ市場本命側の主要Asian Handicap', candidate_favorite_ah))

    market_bets = {}
    for g in games:
        for (market, value), price in g['prices'].items():
            p = settle(market, value, price['odd'], g['ctx'])
            if p is not None:
                market_bets.setdefault((market, value), []).append((p, price['odd']))
    market_rules = [summarize(f'{m} / {v}', b) for (m, v), b in market_bets.items()]
    market_rules = sorted((r for r in market_rules if r and r['bets'] >= 5), key=lambda r: (r['roi_pct'], r['bets']), reverse=True)
    rules = sorted((r for r in rules if r), key=lambda r: (r['roi_pct'], r['bets']), reverse=True)
    output = {'sample': {'settled_games': len(games), 'unsettled': ['Syunik vs Pyunik Yerevan'], 'stake': '各ベット1 unit', 'odds': f'{bookmaker}のみ' if bookmaker else '10Bet優先、10Betに市場がない場合はレスポンス先頭の1社'}, 'games': [{k: v for k, v in g.items() if k not in ('ctx', 'prices')} for g in games], 'candidate_rules': rules, 'favorite_asian_handicap_bets': favorite_ah_details, 'market_rules_min_5_bets': market_rules, 'limitations': ['小標本','相手側の試合前直近5戦は未保存','取得時刻が各試合で完全同時ではない','多数marketの事後探索は多重比較による過学習が非常に強い']}

    POST.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(output, ensure_ascii=False, indent=2))
    print(json.dumps({'candidate_rules': rules, 'top_market_rules': market_rules[:20]}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
