#!/usr/bin/env bash
# Vigil — one-click intranet agent setup (macOS / Linux).
#
# Run this on ANY machine inside your network that can reach your services:
#
#     curl -fsSL https://vigil.kneuralabs.com/agent/run-agent.sh | bash
#
# It downloads the agent, opens a free secure tunnel (no account needed), and
# prints a link that connects the dashboard automatically. No config required.
set -euo pipefail

DASHBOARD="https://vigil.kneuralabs.com"
BASE="${VIGIL_AGENT_BASE:-$DASHBOARD/agent}"
PORT="${VIGIL_PORT:-8787}"
WORK="${VIGIL_HOME:-$HOME/.vigil-agent}"

say(){ printf '\033[36m[vigil]\033[0m %s\n' "$*"; }
err(){ printf '\033[31m[vigil] %s\033[0m\n' "$*" >&2; }

mkdir -p "$WORK"; cd "$WORK"
say "Setup folder: $WORK"

# 1) Python 3 -------------------------------------------------------------
PY="$(command -v python3 || true)"
if [ -z "$PY" ]; then
  err "Python 3 is required. Install it from https://www.python.org/downloads/ and re-run."
  exit 1
fi
say "Using Python: $PY"

# 2) Download the agent + a default config --------------------------------
say "Downloading the monitoring agent…"
curl -fsSL "$BASE/vigil_agent.py" -o vigil_agent.py
if [ ! -f config.json ]; then
  curl -fsSL "$BASE/config.example.json" -o config.json
  say "Created config.json — edit it later to list your own services."
fi

# 3) Get cloudflared (free quick tunnel, no login) ------------------------
CF="$(command -v cloudflared || true)"
if [ -z "$CF" ]; then
  OS="$(uname -s)"; ARCH="$(uname -m)"
  case "$ARCH" in x86_64|amd64) A=amd64;; aarch64|arm64) A=arm64;; *) A=amd64;; esac
  say "Downloading cloudflared ($OS/$A)…"
  if [ "$OS" = "Linux" ]; then
    curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$A" -o cloudflared
  elif [ "$OS" = "Darwin" ]; then
    curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-$A.tgz" -o cf.tgz
    tar -xzf cf.tgz cloudflared
  else
    err "Unsupported OS '$OS'. Install cloudflared manually: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
    exit 1
  fi
  chmod +x cloudflared
  CF="./cloudflared"
fi
say "Using cloudflared: $CF"

# 4) Start the agent ------------------------------------------------------
say "Starting the agent on port $PORT…"
"$PY" vigil_agent.py --config config.json --port "$PORT" >agent.log 2>&1 &
AGENT_PID=$!

# 5) Start the public tunnel ---------------------------------------------
say "Opening a secure public tunnel…"
: >tunnel.log
"$CF" tunnel --url "http://localhost:$PORT" >tunnel.log 2>&1 &
TUNNEL_PID=$!

cleanup(){ say "Stopping agent + tunnel…"; kill "$AGENT_PID" "$TUNNEL_PID" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

# 6) Wait for the public URL ---------------------------------------------
URL=""
for _ in $(seq 1 40); do
  URL="$(grep -oE 'https://[a-z0-9.-]+\.trycloudflare\.com' tunnel.log | head -1 || true)"
  [ -n "$URL" ] && break
  if ! kill -0 "$AGENT_PID" 2>/dev/null; then err "Agent failed to start — see $WORK/agent.log"; exit 1; fi
  sleep 1
done
[ -z "$URL" ] && { err "Could not obtain a tunnel URL — see $WORK/tunnel.log"; exit 1; }

EVENTS="$URL/events"
LINK="$DASHBOARD/?agent=$EVENTS"
echo
say "=================================================="
say "  Your intranet agent is LIVE and connected."
say "=================================================="
echo
say "Open this link — the dashboard connects automatically:"
printf '\n    %s\n\n' "$LINK"
say "(Or paste this into the dashboard's box manually:)"
printf '    %s\n\n' "$EVENTS"
say "Keep this window OPEN. Press Ctrl+C to stop monitoring."

# Open a browser if this is a desktop session (ignored on headless servers).
( command -v xdg-open >/dev/null 2>&1 && xdg-open "$LINK" >/dev/null 2>&1 ) || \
( command -v open     >/dev/null 2>&1 && open     "$LINK" >/dev/null 2>&1 ) || true

wait "$AGENT_PID"
