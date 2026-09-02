# GOAL API Live Monitor

GOAL API Freeプランを使った、ライブ試合一覧・WebSocket statistics監視・検証用の独立プロジェクトです。Goaliseとは完全に分離されています。

## まず使うもの

- Web画面: `apps/web-dashboard/`
- ダブルクリック起動: `start.command`
- APIキー: ルートの `.env` に `GOAL_API_KEY=...`
- 取得ログ: `data/goal_api_test/`

## 起動

Finderから `start.command` をダブルクリックします。または:

```bash
cd /Users/tsukasa/Desktop/goal-api-live-monitor/apps/web-dashboard
npm install
npm run dev
```

ブラウザで http://localhost:3000/ を開きます。

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

## 確認済み仕様

- `/fixtures/live` は試合数に関係なく1 REST request
- Freeプラン実測: 1 WebSocket connection / 最大25 match subscriptions
- WebSocket `match_update`受信は日次1,000 REST quotaを消費しない
- `/ws/token` は日次1,000件とは別のrate-limit bucket
- 正確な試合分数は主にWebSocket `match_status`から取得

## Git運用

コード変更前にコミットし、動作確認後にもう一度コミットします。`.env`、取得ログ、`node_modules`はGitへ含めません。
