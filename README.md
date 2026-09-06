# GOAL API Live Monitor

GOAL API Freeプランを使った、ライブ試合一覧・WebSocket statistics監視・検証用の独立プロジェクトです。Goaliseとは完全に分離されています。

## まず使うもの

- Web画面: `apps/web-dashboard/`
- ダブルクリック起動: `start.command`
- 普段の起動・停止・状態確認: `操作/`
- APIキー: ルートの `.env` に `GOAL_API_KEY=...`
- 取得ログ: `data/goal_api_test/`

Web画面上部のタブで、次の2画面を切り替えられます。

- `ライブ監視`: ライブfixtureを選択してWebSocket監視
- `今後24時間`: 現在時刻から24時間以内に始まる全fixtureをJST順で表示

ライブ監視では、各試合の「現在値をスナップ」から任意時点のstatisticsを保存し、その時点から現在までの増減を比較できます。WebSocketの生更新、手動スナップ、score/status、監視開始・追加・終了はローカルD1へ永続保存されます。保存処理とスナップ比較によるGOAL API REST消費は0です。

WebSocket収集は `services/collector/` のローカルCollectorが担当します。画面を再読み込みしてもCollectorは止まらず、異常切断時だけ自動で再接続・再認証・再subscribeします。「監視を停止」を押した場合は再接続しません。通常時の定期REST statistics pollingは行いません。

`今後24時間`では、取得済みfixtureを追加RESTなしで「指定リーグ」に絞り込めます。対象は5大リーグの1部・2部、オランダ1部・2部に加え、イランPro League、サウジアラビア1部・2部、Coppa Italia、ブルガリアFirst League、オーストリアBundesliga、デンマークSuperliga、ベルギーFirst Division A、スイスSuper League、スコットランドPremiership、Turkey 1. Lig、Qatar Stars League、Algeria Ligue 1、Poland Ekstraklasa、Estonia Esiliiga A、Armenia Premier League、Egypt Premier League、Hungary NB I、エクアドル1部、ブラジル1部・2部、アルゼンチン1部、コロンビア1部です。分析ボタンを押すと、対象のユニークteamごとに `/teams/:id/results?limit=5` を1回取得し、直近5試合で「4勝以上」または「3勝かつ1分以上」のteamを監視候補として表示します。実行前に最大REST数をボタン上で確認できます。

## 起動

Finderから `start.command` をダブルクリックします。または:

```bash
cd /Users/tsukasa/Desktop/goal-api-live-monitor/apps/web-dashboard
npm install
npm run dev
```

ブラウザで http://localhost:3000/ を開きます。

普段はFinderで `操作` フォルダを開き、起動・停止・状態確認の `.command` をダブルクリックするだけで操作できます。Codexへ起動を依頼する必要はありません。

## 構成

```text
goal-api-live-monitor/
├── apps/
│   └── web-dashboard/       # 現在のメイン画面
├── scripts/                 # monitor・API検証スクリプト
├── data/                    # raw JSON・検証結果（Git対象外）
├── .env                     # APIキー（Git対象外）
├── .env.example
├── .gitignore
└── start.command
```

## 主なスクリプト

- `scripts/goal_api_live_stats_dashboard.mjs`: 旧ターミナルライブ画面
- `scripts/goal_api_four_match_websocket_test.mjs`: 複数試合WebSocket検証
- `scripts/goal_api_websocket_quota_test.mjs`: quota実測
- `scripts/goal_api_live_statistics_test.py`: REST statistics検証
- `scripts/goal_api_duplicate_statistics_test.py`: 重複statistics検証
- `scripts/analyze_saved_goal_api_data.py`: 保存済みデータの棚卸し・分析（API request 0）

## 保存データと分析

- これまでのJSON/JSONL: `data/goal_api_test/`
- Web画面の永続DB: `apps/web-dashboard/.wrangler/state/v3/d1/`（Git対象外）
- Collector raw JSONL: `data/goal_api_test/collector/<session_id>/events.jsonl`
- 分析結果: `data/goal_api_test/analysis/latest.json` と `latest.md`

保存済みrawから任意minuteを復元するローカルAPI:

```text
GET /api/timeline?fixtureId=<id>&minute=60&sessionId=<session_id>
```

`targetMinute`、`actualObservedMinute`、`freshnessMinutes`、`missing`、`monitoringSession`、`connectionGap`を返します。外部API通信はありません。

既存データを再分析する場合:

```bash
cd /Users/tsukasa/Desktop/goal-api-live-monitor
python3 scripts/analyze_saved_goal_api_data.py
```

この分析はローカルファイルだけを読み、GOAL API requestを送りません。

## 確認済み仕様

- ライブ一覧は `/fixtures?status=LIVE` と `status=HALF_TIME` をpagination付きで取得します。通常は2 REST requestで、各statusが100件を超える場合は次ページ分が増えます
- 今後24時間は `/fixtures?from=...&to=...&status=SCHEDULED` を取得後、`kickoffUtc`で厳密に絞り込む
- `/fixtures` の実API上の `limit` は最大100件（公開OpenAPIの500件表記とは不一致）
- Freeプラン実測: 1 WebSocket connection / 最大25 match subscriptions
- WebSocket `match_update`受信は日次1,000 REST quotaを消費しない
- `/ws/token` は日次1,000件とは別のrate-limit bucket
- 正確な試合分数は主にWebSocket `match_status`から取得
- 通常監視中のREST statistics pollingは0。Socket再接続時は新しい`/ws/token`だけ取得

## Git運用

コード変更前にコミットし、動作確認後にもう一度コミットします。`.env`、取得ログ、`node_modules`はGitへ含めません。
