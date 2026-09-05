#!/bin/zsh
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
if lsof -nP -iTCP:3000 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "GOAL LIVEはすでに起動しています。"
  if ! lsof -nP -iTCP:4317 -sTCP:LISTEN >/dev/null 2>&1; then
    mkdir -p "$PROJECT_DIR/data"
    nohup node "$PROJECT_DIR/services/collector/collector-daemon.mjs" >> "$PROJECT_DIR/data/collector-daemon.log" 2>&1 &
    sleep 1
    if lsof -nP -iTCP:4317 -sTCP:LISTEN >/dev/null 2>&1; then
      echo "Collectorも起動しました。"
    else
      echo "Collectorの起動に失敗しました。data/collector-daemon.logを確認してください。"
    fi
  fi
  open "http://localhost:3000/"
  exit 0
fi
exec "$PROJECT_DIR/start.command"
