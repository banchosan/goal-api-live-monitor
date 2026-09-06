#!/bin/sh
set -euo pipefail

echo "Installing repository hooks for this clone..."
# Configure local repo to use .githooks directory (local-only setting)
git config core.hooksPath .githooks
chmod +x .githooks/pre-commit || true
echo "Done. Hooks are active for this repository (local git config updated)."

echo "To undo: git config --unset core.hooksPath"
