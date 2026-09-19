# GOAL API Live Monitor

GOAL APIを使い、サッカーのLIVE試合をWebSocketで収集し、`Dangerous Attacks`・shots・cornersなどの時系列から、あとで検証できる形で保存するローカル専用プロジェクトです。

目的は、単に通知を出すことではありません。事前の直近5試合Form、LIVEの攻撃圧、得点・最終結果を同じfixtureに安全に結び、将来のパターン発見・バックテスト・ML用datasetを作れるようにすることです。

> 現在は **ローカルD1 / local Collector / local Dashboard** 専用です。production・remote D1はこの通常運用では使いません。

## 日常の使い方

1. Finderで `操作/` を開き、CollectorとDashboardを起動する。
2. Dashboardの **24時間分析** で今後24時間のfixtureを取得する。
3. 必要なら対象リーグを絞り、直近5試合Form分析を実行する。
4. 好調候補を確認し、必要なら一括Bookmarkする。一括選択は、5試合Formで合格したfixtureだけが対象。
5. 過去の結果は **調子分析履歴** から再表示できる。必要なら保存済み候補だけでオッズ取得をresumeする。
6. Bookmark済み試合はkickoff約3分前から既存SchedulerがCollectorへ渡す。
7. **LIVE監視** でSocketのcurrent stats、25分・HT→65分のsignal、後半の区間比較を確認する。
8. 終了済み試合は **LIVE履歴** で確認する。Collectorの現在メモリから消えても、保存済みデータは残る。

通常の起動はFinderの `.command` を使えばよく、Codexを毎回呼ぶ必要はありません。

## 画面の役割

| 画面 | 用途 | source of truth |
| --- | --- | --- |
| LIVE監視 | 今まさにSocketで受信している試合の確認・手動snapshot・signal表示 | Collector current state + 保存済みfallback |
| 24時間分析 | 今後24時間のfixture、5試合Form分析、好調候補の一括Bookmark、オッズ取得 | GOAL API取得結果・保存済みForm run |
| 調子分析履歴 | 過去の5試合Form run、候補の再確認・オッズresume | `form_analysis_runs` |
| 管理 | Bookmark、監視対象外、AUTO_FORMの反映 | `fixture_bookmarks` / exclusions |
| LIVE履歴 | 完走・中断済みの試合を後から確認 | `live_snapshots` / `live_signals` / `monitor_events` |
| オッズ一覧・分析データ | 保存済みオッズ・結果・分析用出力 | raw + typed PRE-MATCH tables |

### Bookmark と監視対象外は別物

- **Bookmark**: kickoff前から自動監視の予約にする。Schedulerが対象にする。
- **LIVE画面から外す / 監視対象外**: Bookmark・raw・D1履歴を残したまま、今後の自動監視とLIVEカード表示だけを外す。
- **Bookmarkを外す**: 予約そのものを解除する。ただし、すでに集めた履歴は削除しない。

管理画面では日付（JST）を選び、00:00→23:59のkickoff順でBookmarkを表示します。そこで複数選択して「LIVE画面から外す」を行ってもBookmarkは残ります。

## LIVEデータの流れ

```text
GOAL WebSocket match_update
        │
        ├─ raw JSONL                         再解析できる原本
        ├─ monitor_events (D1)               durable event record
        └─ live_snapshots (D1)               typed時系列・分析の母集団
                 │
                 ├─ live_signals (D1)        条件を満たしたイベントだけ
                 ├─ LIVE Dashboard            実時間表示
                 ├─ LIVE履歴                  終了後の確認
                 └─ read-only analysis CSV    dataset / backtest
```

### 保存方針

- **RAW** はAPIから届いた原本。normalizer変更後でも再投影できるため、消さない。
- **`monitor_events`** は受信イベントの永続ログ。接続・subscribe・disconnect等の観測性にも使う。
- **`live_snapshots`** は有効な`match_update`ごとのtyped時系列。後から任意minute・任意windowを再計算するため、固定区間の集計tableをむやみに増やさない。
- **`live_signals`** は「条件を満たしたケース」の証拠。baseline / trigger snapshot・rule version・detected minuteなどを残す。

NULLは0ではありません。欠損したDA・shots・scoreを0に置換せず、分析時もNULLのまま扱います。

## LIVE監視のルールと表示

### 25分 DA

キックオフ時刻の0分値を待たず、25分以前に実際に受信した最後のSocket更新をcheckpointとして使います。HOMEまたはAWAYのDAが20以上なら表示を強調します。

### HT → 65分 DA

`actual Half Time` を**このCollector sessionで実際に観測した場合だけ**baselineにします。45分の値、途中接続時点の値、過去DBの値をHTとして推測しません。

```text
current DA - actual HT DA >= 15
かつ minute <= 65
```

を満たすとHOME/AWAY別に一度だけsignalを保存します。65分を超えた後も、65分以前の最後の表示値と発火分数を消しません。

### 65→70 / 70→75 / 75→80 比較

LIVEカードには、必要な区間だけ開ける折りたたみ式の比較カードを表示します。

- HT → 65
- 65 → 70
- 70 → 75
- 75 → 80

各targetについて、target以後の未来データは使わず、**target以前で最新のSocket更新**を採用します。DA、On/Off Target、Corners、Attacks、Possessionの終点値と増減を確認できます。これは画面上の再計算であり、区間別の重複データは保存しません。

### Provider異常への扱い

GOAL providerが試合中に一時的な`NOT_STARTED` / `match_live=0` / minute空のframeを送ることがあります。このframeはRAWとして残しますが、`match_live=0`単独ではfinished扱いにせずunsubscribeしません。明示的なterminal statusだけで終了させます。

WebSocketはheartbeat、再認証、再subscribe、指数backoffを持ちます。ただしproviderが更新を送らない時間やネットワーク断は完全には防げません。Dashboardのdata gap・LIVE履歴で確認してください。

## Bookmark Scheduler

- BookmarkはD1へ永続化される。
- kickoff約3分前に既存SchedulerがCollectorへ渡す。
- 1本のWebSocket connection上で最大25 fixtureをsubscribeする。
- 超過分はkickoff順にqueueする。
- restart recovery、FT unsubscribe、manual / AUTO_FORM共存を持つ。
- 同じfixtureをMANUALとAUTO_FORMで二重subscribeしない。

AUTO_FORMは、Form条件に合格し、正式GOAL league IDのallowlistを通り、安全なGOAL fixture identityを作成または再利用できたfixtureだけをBookmarkします。名前だけによるteam/fixture mergeはしません。

## PRE-MATCH データ

```text
upcoming fixtures
  → 直近5試合Form
  → Form candidates
  → odds / result
  → raw保存 + typed保存
```

24時間取得は対象UTC日を100件ずつページングし、GOAL APIの`pagination.hasMore`が終わるまで続けます。固定の1,000 fixture上限は設けません。同じ非空ページが繰り返された場合だけ、安全に停止して画面上で一部取得であることを通知します。

### 5試合Form

対象リーグはDashboardの`isSelectedLeague`定義にあり、国・league表記を正規化して判定します。England National League、France National / League 3、Turkey 1. Lig（2部）/ 2. Lig（3部）、Netherlands Tweede Divisie、Latvia Higher League、Norway 1st / 2nd Division、Indonesia Super League、Thai League 1も5試合Form分析対象です。Form候補条件は直近5試合で「4勝以上」「3勝+1分以上」、または直近3試合の3連勝です。直近2試合がLL / DL / LDなら除外します。直近3連勝は、先行する2試合が負けでも（例: L-L-W-W-W）候補になります。

1回のForm分析はユニークteamごとにGOAL APIを1回使います。現在は最大500チームまでを、同時3 requestの逐次batchで処理します。対象リーグを広げても一括大量発射にはしません。

Form runは保存されるため、保存済み候補からオッズだけを再取得できます。この導線ではGOALのupcoming / form APIを再消費せず、必要なAPI-Football oddsだけを使います。オッズは40 fixture単位で進め、成功済みraw odds snapshotを確認して未完了分だけresumeします。

**調子分析履歴** は標準カード表示に加え、`国・リーグ別`表示を選べます。🇬🇧 England / 🇪🇸 Spain / 🇩🇪 Germany / 🇮🇹 Italy / 🇫🇷 Franceを先頭固定にし、残りの国・各国のleagueはアルファベット順です。

### RAW と TYPED

| 種別 | RAW | TYPED |
| --- | --- | --- |
| Form | `form_analysis_runs` 等 | `prematch_form_observations` |
| Odds | `odds_analysis_runs` / `odds_snapshots` | `odds_capture_runs_v2` / `odds_market_values` |
| Result | `result_snapshots` | `match_results_v2` |
| LIVE | JSONL / `monitor_events` | `live_snapshots` / `live_signals` |

RAWは最優先です。typed conversion・identity・normalizerが失敗しても、取得済みの原本を失わないことを設計原則にしています。

## Fixture / Team identity

Core identityはprovider固有IDを根拠にします。

- `team_provider_ids`: `provider + external_team_id → core_team`
- `fixture_provider_ids`: `provider + external_fixture_id → core_fixture`
- `core_fixtures`: home / away core team、kickoff、leagueを持つ

GOAL provider内のfixtureは、fixture ID・home/away team ID・kickoff・league IDが揃うときだけ作成します。既存GOAL mappingがあれば、その`core_team`を必ず再利用します。name-only mergeは禁止です。

GOALとAPI-Footballのcross-provider統合は別処理です。fixture identity bridgeが複数evidenceで`SAFE`と判定した場合だけ行い、通常のGOAL identity作成が勝手にAPI-Football mappingを足すことはありません。

## 分析dataset（read-only）

保存済み`live_snapshots`から、1行 = `fixture × side × checkpoint` のCSVを作れます。書き込み・外部API・WebSocket接続はしません。

```bash
cd /Users/tsukasa/Desktop/goal-api-live-monitor
node --experimental-strip-types scripts/live_analysis_dataset.ts
```

主な列:

- checkpoints: 55 / 60 / 65（actual HT baselineとcausal checkpoint）
- DA、shots、SOT、corners、attacks、possessionの差分
- score state
- HOME/AWAY別の次の5 / 10 / 15分得点ラベル
- cumulative correction・欠損のanomaly flag

未来snapshotはfeature計算に使いません。未来データを使うのは、ラベル（次の5/10/15分に得点したか）の列だけです。40試合規模はpipeline検証・探索には使えますが、利益性や再現性の証明には不十分です。

## 運用上の重要な学び

このプロジェクトで実運用・監査を通じて確立したルールです。

1. **RAW first** — providerの欠損・JSON不正・identity未解決でも、受信済み原本を捨てない。
2. **actual HT only** — minute=45や途中接続時の値からHT baselineを推測するとlook-aheadや偽signalになる。
3. **causal checkpoint** — 60分を表示するのに61分の値を使わない。各target以前の最新観測だけを使う。
4. **NULL ≠ 0** — 未配信、placeholder、実測0を混同しない。
5. **signalは母集団ではない** — 発火試合だけでなく、全監視fixtureの`live_snapshots`を残してnon-signal control群も分析する。
6. **Collector memoryは表示用** — 終了試合の事実はD1履歴を見る。daemonの再起動・unsubscribeで履歴が消えたように見えてはいけない。
7. **provider anomalyをterminal扱いしない** — explicit terminal statusだけで終了する。

## 起動・テスト

Dashboard開発起動:

```bash
cd /Users/tsukasa/Desktop/goal-api-live-monitor/apps/web-dashboard
npm run dev
```

テストとproduction build:

```bash
npm test
npm run build
```

主要なデータ位置:

```text
data/goal_api_test/collector/<session_id>/events.jsonl  # immutable raw
apps/web-dashboard/.wrangler/state/v3/d1/              # local D1（Git対象外）
scripts/live_analysis_dataset.ts                         # read-only dataset exporter
scripts/live_delta_report.ts                             # checkpoint/delta report
```

`.env`、local D1、raw JSONL、`node_modules`はGitへ含めません。

## Git運用

Gitは「毎日必須」ではなく、意味のある安全な区切りでcommitします。

- 画面の小改善、Collectorの挙動変更、schema変更、分析script追加など、あとで戻したくなりそうな単位でcommitする。
- 実装 → テスト → production build → commit が基本。
- 調査だけ、READMEの軽微な誤字、未完の実験は無理にcommitしない。
- commitしなくてもファイル変更はローカルに残るが、PC障害・誤操作・別変更の混入から守る履歴にはならない。
- API key、rawデータ、local D1はcommitしない。

このプロジェクトでは、Collectorや保存構造に関わる変更は特にcommitを推奨します。画面上の一つの機能だけの変更でも、関連するテストが通った時点で独立commitにすると、問題発生時に原因を追いやすくなります。
