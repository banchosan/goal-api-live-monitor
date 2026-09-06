#!/bin/zsh
set -euo pipefail

# Start script with symlink self-healing for .env files and safe checks.
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
WEB_DIR="$PROJECT_DIR/apps/web-dashboard"

echo "Starting GOAL LIVE launcher..."

# Ensure root .env exists
if [[ ! -f "$PROJECT_DIR/.env" ]]; then
  echo "エラー: $PROJECT_DIR/.env がありません"
  echo ".env.example をコピーして GOAL_API_KEY 等を設定してください。"
  read -k 1 "?何かキーを押すと終了します…"
  exit 1
fi

# Do not print or expose secret values; only check variable presence
set -a
source "$PROJECT_DIR/.env"
set +a

missing_keys=()
if [[ -z "${GOAL_API_KEY:-}" ]]; then
  missing_keys+=(GOAL_API_KEY)
fi
if [[ -z "${API_FOOTBALL_KEY:-}" ]]; then
  missing_keys+=(API_FOOTBALL_KEY)
fi
if (( ${#missing_keys[@]} > 0 )); then
  echo "エラー: 必要な環境変数が設定されていません。"
  echo "不足: ${#missing_keys[@]} 個の環境変数が設定されていません。"
  echo "詳細は .env をご確認ください（値は表示されません）。"
  exit 1
fi

# Helper to create or repair symlink safely
ensure_symlink() {
  local target_path="$1" # expected symlink path
  local dest_rel="$2"    # relative target from symlink (e.g. ../../.env)

  if [[ -L "$target_path" ]]; then
    # It's a symlink; check destination
    local current_dest
    current_dest=$(readlink "$target_path" || true)
    if [[ "$current_dest" == "$dest_rel" ]]; then
      return 0
    else
      echo "修復: $target_path のシンボリックリンク先が異なるため修正します。"
      rm "$target_path"
      ln -s "$dest_rel" "$target_path"
      return 0
    fi
  elif [[ -e "$target_path" ]]; then
    # Exists and is not a symlink -> do not overwrite
    echo "警告: $target_path は通常ファイルとして存在します。上書きしません。"
    echo "必要であれば手動で root .env を参照するシンボリックリンクを作成してください。"
    return 1
  else
    # Create symlink
    ln -s "$dest_rel" "$target_path"
    echo "作成: $target_path -> $dest_rel"
    return 0
  fi
}

# Ensure subdir env symlinks
ensure_symlink "$PROJECT_DIR/apps/web-dashboard/.env" "../../.env" || true
ensure_symlink "$PROJECT_DIR/scripts/.env" "../.env" || true

# Proceed to start services
cd "$WEB_DIR"
if [[ ! -d node_modules ]]; then
  echo "初回セットアップ: npm install を実行します..."
  npm install
fi

# Remove stale lock if present
rm -f "$WEB_DIR/.vinext/dev/lock.json" || true

echo "GOAL LIVE を起動します: http://localhost:3000/"
COLLECTOR_PID=""
if ! lsof -nP -iTCP:4317 -sTCP:LISTEN >/dev/null 2>&1; then
  node "$PROJECT_DIR/services/collector/collector-daemon.mjs" >> "$PROJECT_DIR/data/collector-daemon.log" 2>&1 &
  COLLECTOR_PID=$!
fi

cleanup() {
  if [[ -n "${COLLECTOR_PID:-}" ]]; then kill "$COLLECTOR_PID" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT INT TERM

# Start the dashboard dev server (or production runner if configured)
npm run dev
