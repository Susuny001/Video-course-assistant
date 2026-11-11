#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
mkdir -p data/setup data/logs
if ! command -v python3 >/dev/null; then echo 'Python 3.11+ is required.' >&2; exit 1; fi
if [[ "${1:-}" == '--foreground' ]]; then
  exec python3 scripts/setup-all.py --start
fi
if [[ -f data/setup/installer.pid ]]; then
  read -r setup_pid < data/setup/installer.pid
  if [[ "$setup_pid" =~ ^[0-9]+$ ]] && kill -0 "$setup_pid" 2>/dev/null && [[ -r "/proc/$setup_pid/cmdline" ]] && tr '\0' ' ' < "/proc/$setup_pid/cmdline" | grep -Fq 'scripts/setup-all.py'; then
    echo 'Setup is already running. Open data/setup/status.html to view progress.'
    exit 0
  fi
fi
nohup python3 scripts/setup-all.py --start > data/logs/setup.log 2>&1 < /dev/null &
printf '%s\n' "$!" > data/setup/installer.pid
printf 'Setup continues in the background (PID %s). Progress: %s/data/setup/status.html\n' "$!" "$PWD"
