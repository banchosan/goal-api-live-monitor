#!/bin/zsh
PIDS="$(lsof -tiTCP:3000 -sTCP:LISTEN)"
if [[ -z "$PIDS" ]]; then
  echo "GOAL LIVEは起動していません。"
else
  echo "$PIDS" | xargs kill
  echo "GOAL LIVEを停止しました。"
fi
read -k 1 "?何かキーを押すと閉じます…"
