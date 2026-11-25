#!/bin/bash
# Builds the web page (web/dist) and the macOS host app. Deps come only from the committed
# lockfile, with no install scripts.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WEB="$ROOT/web/pixel-agents"

cd "$WEB"
[ -d node_modules ] || npm ci --ignore-scripts --no-audit --no-fund
npm run build

"$ROOT/scripts/macos/build-host.sh"
