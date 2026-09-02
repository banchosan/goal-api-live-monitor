#!/bin/zsh
set -e
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
WEB_DIR="$PROJECT_DIR/apps/web-dashboard"
cd "$WEB_DIR"
if [[ ! -d node_modules ]]; then
  echo "初回セットアップ中です…"
  npm install
fi
echo "GOAL LIVEを起動します: http://localhost:3000/"
npm run dev
