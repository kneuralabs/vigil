# Vigil Intranet Agent

The Vigil dashboard (`vigil.kneuralabs.com`) runs in your browser, so it can
reach **public** endpoints but **not** `intranet.kneuralabs.com` — that network
is private by design. This agent closes the gap: you run it on a box *inside*
the network, it health-checks your internal services, and it serves their
status as JSON in the exact shape the dashboard polls.

```
intranet services  ──►  vigil_agent.py  ──►  /events (JSON)  ──►  dashboard feed
   (private)            (inside network)      (CORS-enabled)       (your browser)
```

- **Dependency-free.** Pure Python 3.7+ standard library. No `pip install`.
- **Read-only.** It performs `GET` health checks. It does not log into,
  modify, or store data from your services.
- **You own the data path.** Events never leave your infrastructure unless you
  explicitly set a `webhook_url`.

## Quick start

```bash
cd agent
cp config.example.json config.json     # edit the services list to match yours
python3 vigil_agent.py --config config.json
```

You'll see:

```
Vigil agent listening on http://0.0.0.0:8787/events
Monitoring 7 service(s) every 30s
```

Verify the feed:

```bash
curl http://localhost:8787/events
```

## Connecting it to the dashboard

The dashboard does a cross-origin `GET` on the URL you paste into its
**"Connect Intranet Agent"** box, then renders the returned `{type,title,message}`
objects. Pick whichever delivery model fits your security posture:

### Option A — PULL (agent is reachable from the browser)

Expose `/events` to wherever you open the dashboard. Common choices:

- **Cloudflare Tunnel** (recommended; no inbound ports opened):
  ```bash
  cloudflared tunnel --url http://localhost:8787
  ```
  Paste the resulting `https://<random>.trycloudflare.com/events` URL into the
  dashboard.
- **Reverse proxy** behind your existing ingress (nginx/Caddy) at e.g.
  `https://agent.kneuralabs.com/events`.
- **On-network only:** open the dashboard from a machine on the LAN and paste
  `http://<agent-host>:8787/events`.

Set an `auth_token` in the config to require `?token=...` on the URL.

### Option B — PUSH (agent stays fully private)

Set `"webhook_url"` in `config.json` to a public relay you control (a
Cloudflare Worker, Pipedream, or Make.com endpoint). The agent `POST`s new
events there; you point the dashboard at the relay's **read** URL. Nothing
inbound ever touches your network.

## Configuration (`config.json`)

| Key | Default | Meaning |
|-----|---------|---------|
| `bind_host` | `0.0.0.0` | Interface to listen on (`127.0.0.1` to keep it local). |
| `bind_port` | `8787` | Port for the `/events` server. |
| `poll_interval_seconds` | `30` | How often each service is health-checked. |
| `request_timeout_seconds` | `5` | Per-request timeout. |
| `slow_threshold_ms` | `1500` | Above this, a healthy service is flagged `warn`. |
| `event_buffer_size` | `200` | Rolling number of events kept in memory. |
| `verify_tls` | `true` | Set `false` only for internal self-signed certs. |
| `auth_token` | `""` | If set, `/events` requires the token (query or Bearer). |
| `webhook_url` | `""` | If set, events are also POSTed here (Option B). |
| `services` | 7 intranet apps | `[{ "name", "url" }]` list to monitor. |

### Status logic

| Result | Status |
|--------|--------|
| `2xx`/`3xx` within `slow_threshold_ms` | `ok` |
| slow, or `401`/`403` (auth-gated), or other `4xx` | `warn` |
| `5xx`, timeout, connection refused / DNS failure | `crit` |

Events are emitted on **state change** (e.g. `ok → crit`) so the live feed shows
transitions without flooding.

## Endpoints

| Method | Path | Returns |
|--------|------|---------|
| `GET` | `/events` | Array of recent events (the dashboard format). |
| `GET` | `/health` | `{"status":"ok"}` liveness probe. |
| `OPTIONS` | any | CORS preflight. |

## Running as a service

### systemd

```bash
sudo useradd -r -s /usr/sbin/nologin vigil
sudo mkdir -p /opt/vigil-agent
sudo cp vigil_agent.py config.json /opt/vigil-agent/
sudo cp vigil-agent.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now vigil-agent
```

### Docker

```bash
cp config.example.json config.json   # edit first
docker build -t vigil-agent .
docker run -d --name vigil-agent -p 8787:8787 vigil-agent
```

## Security notes

- The agent only issues outbound `GET` requests to the URLs you list. It stores
  nothing on disk and keeps just a small in-memory event ring.
- Prefer `bind_host: 127.0.0.1` plus a tunnel/proxy over exposing `0.0.0.0`.
- Set an `auth_token` whenever `/events` is reachable beyond localhost.
- Run as the unprivileged `vigil` user (the systemd unit and Dockerfile do).
