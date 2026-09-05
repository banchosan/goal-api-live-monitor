#!/bin/zsh
if lsof -nP -iTCP:3000 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "状態: 起動中"
  echo "URL: http://localhost:3000/"
else
  echo "状態: 停止中"
  echo "「GOAL LIVEを起動.command」をダブルクリックしてください。"
fi
if lsof -nP -iTCP:4317 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Collector: 起動中（ブラウザと独立して収集中）"
else
  echo "Collector: 停止中"
fi
read -k 1 "?何かキーを押すと閉じます…"
