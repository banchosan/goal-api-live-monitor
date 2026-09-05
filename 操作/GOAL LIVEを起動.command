#!/bin/zsh
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
if lsof -nP -iTCP:3000 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "GOAL LIVEはすでに起動しています。"
  open "http://localhost:3000/"
  exit 0
fi
exec "$PROJECT_DIR/start.command"
