#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
if [[ "${1:-}" == '--background' ]]; then
  mkdir -p data/logs data/setup
  nohup python3 scripts/setup-all.py --start-only > data/logs/setup.log 2>&1 < /dev/null &
  echo 'Startup continues in the background; progress is in data/setup/status.html.'
  exit 0
fi
node -e 'if ((() => { const [major, minor] = process.versions.node.split(".").map(Number); return major < 22 || (major === 22 && minor < 12) })()) { console.error("Node.js 22.12+ required"); process.exit(1) }'
if [[ ! -d node_modules/tsx || ! -f dist/index.html ]]; then
  echo 'Run npm ci and npm run build first.' >&2
  exit 1
fi
# Keep this process in the foreground so Ctrl-C and service managers can stop it reliably.
export HOST="${HOST:-127.0.0.1}"
exec node --import tsx server/index.ts
