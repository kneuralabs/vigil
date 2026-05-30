#!/usr/bin/env bash
# Vigil — intranet agent setup (macOS / Linux).
#
# QUICK (default): zero-config, ephemeral public URL. Great to get going now.
#     curl -fsSL https://vigil.kneuralabs.com/agent/run-agent.sh | bash
#
# PERMANENT: stable named Cloudflare tunnel on a hostname you own (URL survives
# restarts). Needs a free Cloudflare account and a domain in your Cloudflare zone.
#     curl -fsSL https://vigil.kneuralabs.com/agent/run-agent.sh | bash -s -- \
#          --permanent --hostname agent.kneuralabs.com
#
# Options:
#   --permanent              use a stable named tunnel (instead of a quick tunnel)
#   --hostname <host>        public hostname for --permanent (required)
#   --name <tunnel-name>     tunnel name (default: vigil-agent)
#   --port <port>            local agent port (default: 8787)
#   -h, --help               show this help
set -euo pipefail

DASHBOARD="https://vigil.kneuralabs.com"
BASE="${VIGIL_AGENT_BASE:-$DASHBOARD/agent}"
PORT="${VIGIL_PORT:-8787}"
WORK="${VIGIL_HOME:-$HOME/.vigil-agent}"
MODE="quick"
HOST=""
NAME="vigil-agent"

say(){ printf '\033[36m[vigil]\033[0m %s\n' "$*"; }
err(){ printf '\033[31m[vigil] %s\033[0m\n' "$*" >&2; }
usage(){ sed -n '2,22p' "$0" 2>/dev/null || true; }

while [ $# -gt 0 ]; do
  case "$1" in
    --permanent) MODE="permanent" ;;
    --hostname) HOST="${2:-}"; shift ;;
    --name) NAME="${2:-vigil-agent}"; shift ;;
    --port) PORT="${2:-8787}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) err "Unknown option: $1"; exit 2 ;;
  esac
  shift
done

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

# 3) Get cloudflared ------------------------------------------------------
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
  CF="$PWD/cloudflared"
fi
say "Using cloudflared: $CF"

# 4) Start the agent (both modes) ----------------------------------------
say "Starting the agent on port $PORT…"
"$PY" vigil_agent.py --config config.json --port "$PORT" >agent.log 2>&1 &
AGENT_PID=$!
cleanup(){ say "Stopping agent + tunnel…"; kill "$AGENT_PID" "${TUNNEL_PID:-}" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

announce(){ # $1 = events URL
  local events="$1" link
  link="$DASHBOARD/?agent=$events"
  echo
  say "=================================================="
  say "  Your intranet agent is LIVE and connected."
  say "=================================================="
  echo
  say "Open this link — the dashboard connects automatically:"
  printf '\n    %s\n\n' "$link"
  say "(Or paste this into the dashboard's box manually:)"
  printf '    %s\n\n' "$events"
  ( command -v xdg-open >/dev/null 2>&1 && xdg-open "$link" >/dev/null 2>&1 ) || \
  ( command -v open     >/dev/null 2>&1 && open     "$link" >/dev/null 2>&1 ) || true
}

# ------------------------------------------------------------------------
if [ "$MODE" = "quick" ]; then
  say "Opening a secure quick tunnel (ephemeral URL)…"
  : >tunnel.log
  "$CF" tunnel --url "http://localhost:$PORT" >tunnel.log 2>&1 &
  TUNNEL_PID=$!
  URL=""
  for _ in $(seq 1 40); do
    URL="$(grep -oE 'https://[a-z0-9.-]+\.trycloudflare\.com' tunnel.log | head -1 || true)"
    [ -n "$URL" ] && break
    if ! kill -0 "$AGENT_PID" 2>/dev/null; then err "Agent failed to start — see $WORK/agent.log"; exit 1; fi
    sleep 1
  done
  [ -z "$URL" ] && { err "Could not obtain a tunnel URL — see $WORK/tunnel.log"; exit 1; }
  announce "$URL/events"
  say "Quick-tunnel URL is temporary. For a stable URL, re-run with: --permanent --hostname <your-host>"
  say "Keep this window OPEN. Press Ctrl+C to stop monitoring."
  wait "$AGENT_PID"
  exit 0
fi

# ---- PERMANENT: named tunnel on a hostname you own ----------------------
if [ -z "$HOST" ]; then
  err "--permanent requires --hostname <host> (a name in a domain on your Cloudflare account, e.g. agent.kneuralabs.com)."
  exit 2
fi
export TUNNEL_ORIGIN_CERT="$HOME/.cloudflared/cert.pem"

if [ ! -f "$HOME/.cloudflared/cert.pem" ]; then
  say "One-time Cloudflare login — a browser window will open; pick the domain that owns $HOST."
  "$CF" tunnel login
fi

# Find or create the named tunnel; resolve its UUID via the JSON listing.
TID="$("$CF" tunnel list --output json 2>/dev/null \
       | "$PY" -c "import sys,json;             \
n='$NAME';                                       \
print(next((t['id'] for t in (json.load(sys.stdin) or []) if t.get('name')==n),''))" 2>/dev/null || true)"
if [ -z "$TID" ]; then
  say "Creating named tunnel '$NAME'…"
  "$CF" tunnel create "$NAME"
  TID="$("$CF" tunnel list --output json 2>/dev/null \
         | "$PY" -c "import sys,json;n='$NAME';print(next((t['id'] for t in (json.load(sys.stdin) or []) if t.get('name')==n),''))" 2>/dev/null || true)"
fi
[ -z "$TID" ] && { err "Could not create/find tunnel '$NAME'."; exit 1; }
say "Tunnel '$NAME' id: $TID"

CRED="$HOME/.cloudflared/$TID.json"
CFG="$WORK/cloudflared-config.yml"
cat > "$CFG" <<YAML
tunnel: $TID
credentials-file: $CRED
ingress:
  - hostname: $HOST
    service: http://localhost:$PORT
  - service: http_status:404
YAML
say "Wrote tunnel config: $CFG"

say "Routing DNS $HOST → tunnel…"
"$CF" tunnel route dns "$NAME" "$HOST" || say "(DNS route may already exist — continuing.)"

# Generate ready-to-install systemd units for 24/7 operation.
cat > "$WORK/vigil-agent.service" <<UNIT
[Unit]
Description=Vigil Intranet Agent
After=network-online.target
Wants=network-online.target
[Service]
ExecStart=$PY $WORK/vigil_agent.py --config $WORK/config.json --port $PORT
WorkingDirectory=$WORK
Restart=on-failure
RestartSec=5
User=$USER
[Install]
WantedBy=multi-user.target
UNIT
cat > "$WORK/vigil-tunnel.service" <<UNIT
[Unit]
Description=Vigil Cloudflare Tunnel ($NAME)
After=network-online.target vigil-agent.service
Wants=network-online.target
[Service]
ExecStart=$CF tunnel --config $CFG run $NAME
Restart=on-failure
RestartSec=5
User=$USER
[Install]
WantedBy=multi-user.target
UNIT

announce "https://$HOST/events"
say "Stable URL — it stays the same across restarts."
echo
say "Run it 24/7 (survives reboots) with systemd:"
printf '    sudo cp %s/vigil-agent.service %s/vigil-tunnel.service /etc/systemd/system/\n' "$WORK" "$WORK"
printf '    sudo systemctl daemon-reload && sudo systemctl enable --now vigil-agent vigil-tunnel\n\n'
say "Running in the foreground now. Press Ctrl+C to stop (or use the systemd units above)."
"$CF" tunnel --config "$CFG" run "$NAME" &
TUNNEL_PID=$!
wait "$AGENT_PID"
