#!/bin/bash
# Opens one device browser pane. Run this inside a terminal that terminal-browser supports
# (Tern, kitty, Ghostty, WezTerm, tmux, VS Code), not from a piped shell.
set -euo pipefail
ROOT="${IG_PROFILE_ROOT:-$HOME/.0click/instagram}"
ID="${1:?device id}"
URL="${2:-https://www.instagram.com/}"
D="$ROOT/devices/$ID"
[ -d "$D" ] || { echo "unknown device: $ID (create it with device_create)" >&2; exit 1; }
SOCKS=""
if [ -f "$D/meta.json" ] && command -v node >/dev/null 2>&1; then
  PORT="$(node -e "try{const m=require('$D/meta.json');process.stdout.write(m.socksPort?String(m.socksPort):'')}catch{}")"
  [ -n "$PORT" ] && SOCKS="--socks-port=$PORT"
fi
export XDG_STATE_HOME="$D/state"
export XDG_DATA_HOME="$D/data"
export XDG_RUNTIME_DIR="$D/run"
export TERMINAL_BROWSER_APPDATA="$D/appdata"
export AGENT_BROWSER_SOCKET_DIR="$D/agent"
mkdir -p "$XDG_STATE_HOME" "$XDG_DATA_HOME" "$XDG_RUNTIME_DIR" "$TERMINAL_BROWSER_APPDATA" "$AGENT_BROWSER_SOCKET_DIR"
exec terminal-browser open "$URL" $SOCKS
