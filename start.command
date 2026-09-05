#!/bin/zsh
set -e
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
WEB_DIR="$PROJECT_DIR/apps/web-dashboard"
if [[ ! -f "$PROJECT_DIR/.env" ]]; then
  echo "エラー: $PROJECT_DIR/.env がありません"
  echo ".env.exampleをコピーしてGOAL_API_KEYを設定してください。"
  read -k 1 "?何かキーを押すと終了します…"
  exit 1
fi
set -a
source "$PROJECT_DIR/.env"
set +a
cd "$WEB_DIR"
if [[ ! -d node_modules ]]; then
  echo "初回セットアップ中です…"
  npm install
fi
# vinextが異常終了した場合に残るロックだけを除去する。起動中なら
# このスクリプトの先頭で終了しているため、稼働中サーバーには触れない。
rm -f "$WEB_DIR/.vinext/dev/lock.json"
echo "GOAL LIVEを起動します: http://localhost:3000/"
COLLECTOR_PID=""
if ! lsof -nP -iTCP:4317 -sTCP:LISTEN >/dev/null 2>&1; then
  node "$PROJECT_DIR/services/collector/collector-daemon.mjs" >> "$PROJECT_DIR/data/collector-daemon.log" 2>&1 &
  COLLECTOR_PID=$!
fi
cleanup() {
  if [[ -n "$COLLECTOR_PID" ]]; then kill "$COLLECTOR_PID" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT INT TERM
npm run dev
