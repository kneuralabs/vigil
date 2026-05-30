#!/usr/bin/env python3
"""
Vigil Intranet Agent
====================

A tiny, dependency-free monitoring agent you run *inside* your private network
(e.g. on a box that can reach intranet.kneuralabs.com). It periodically
health-checks your internal services and exposes their status as JSON in the
exact shape the Vigil dashboard expects:

    [{"type": "ok|info|warn|crit", "title": "...", "message": "...", "time": "..."}]

Two ways to get those events to the dashboard (vigil.kneuralabs.com):

  1. PULL  - The agent serves GET /events (CORS-enabled). If this agent is
             reachable from the browser (e.g. via a Cloudflare Tunnel, a
             reverse proxy, or because the dashboard is opened on-network),
             paste that URL into the dashboard's "Connect Intranet Agent" box.

  2. PUSH  - Set "webhook_url" in the config. The agent POSTs each new event
             batch to a public relay you control (Pipedream / Make.com /
             Cloudflare Worker), and you point the dashboard at the relay's
             read URL. Use this when the agent must stay fully private.

Standard library only. Works on Python 3.7+. No pip install required.

Usage:
    python3 vigil_agent.py --config config.json
    python3 vigil_agent.py            # uses ./config.json if present, else defaults
"""

import argparse
import json
import os
import ssl
import sys
import threading
import time
import urllib.error
import urllib.request
from collections import deque
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# --------------------------------------------------------------------------- #
# Defaults — mirror the apps the dashboard lists under "Monitored Apps".
# Override entirely via config.json.
# --------------------------------------------------------------------------- #
DEFAULT_CONFIG = {
    "bind_host": "0.0.0.0",
    "bind_port": 8787,
    "poll_interval_seconds": 30,
    "request_timeout_seconds": 5,
    "slow_threshold_ms": 1500,
    "event_buffer_size": 200,
    "verify_tls": True,
    # Optional shared secret. If set, /events requires ?token=... or
    # an "Authorization: Bearer <token>" header.
    "auth_token": "",
    # Optional push target. If set, new events are POSTed here as JSON.
    "webhook_url": "",
    "services": [
        {"name": "SSO / Auth Portal", "url": "https://intranet.kneuralabs.com/auth"},
        {"name": "HR System", "url": "https://intranet.kneuralabs.com/hr"},
        {"name": "Dev Tools", "url": "https://intranet.kneuralabs.com/dev"},
        {"name": "File Storage", "url": "https://intranet.kneuralabs.com/files"},
        {"name": "Analytics", "url": "https://intranet.kneuralabs.com/analytics"},
        {"name": "VPN Gateway", "url": "https://intranet.kneuralabs.com/vpn"},
        {"name": "API Gateway", "url": "https://intranet.kneuralabs.com/api"},
    ],
}


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def hhmmss():
    return datetime.now(timezone.utc).strftime("%H:%M:%S")


class EventLog:
    """Thread-safe rolling buffer of dashboard-shaped events."""

    def __init__(self, maxlen):
        self._events = deque(maxlen=maxlen)
        self._lock = threading.Lock()

    def add(self, etype, title, message):
        evt = {
            "type": etype,
            "title": title,
            "message": message,
            "time": hhmmss(),
            "ts": now_iso(),
        }
        with self._lock:
            self._events.append(evt)
        return evt

    def snapshot(self):
        with self._lock:
            # Newest last is fine; dashboard appends in order received.
            return list(self._events)


class Monitor(threading.Thread):
    """Background poller that health-checks each configured service."""

    daemon = True

    def __init__(self, config, log):
        super().__init__(name="vigil-monitor")
        self.cfg = config
        self.log = log
        self._last_status = {}  # service name -> "ok"|"warn"|"crit"
        self._stop = threading.Event()
        if config.get("verify_tls", True):
            self._ssl_ctx = ssl.create_default_context()
        else:
            self._ssl_ctx = ssl._create_unverified_context()

    def stop(self):
        self._stop.set()

    def _check(self, svc):
        """Return (status, message) for one service."""
        url = svc["url"]
        timeout = self.cfg.get("request_timeout_seconds", 5)
        req = urllib.request.Request(url, method="GET", headers={"User-Agent": "vigil-agent/1.0"})
        start = time.monotonic()
        try:
            with urllib.request.urlopen(req, timeout=timeout, context=self._ssl_ctx) as resp:
                elapsed_ms = int((time.monotonic() - start) * 1000)
                code = resp.getcode()
        except urllib.error.HTTPError as e:
            elapsed_ms = int((time.monotonic() - start) * 1000)
            code = e.code
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            reason = getattr(e, "reason", e)
            return "crit", "unreachable ({})".format(reason)

        slow = self.cfg.get("slow_threshold_ms", 1500)
        if code >= 500:
            return "crit", "HTTP {} ({} ms)".format(code, elapsed_ms)
        if code >= 400:
            # 401/403 from an SSO-protected endpoint means it's alive & guarding.
            note = "auth-gated" if code in (401, 403) else "client error"
            return "warn", "HTTP {} {} ({} ms)".format(code, note, elapsed_ms)
        if elapsed_ms > slow:
            return "warn", "slow: HTTP {} in {} ms".format(code, elapsed_ms)
        return "ok", "HTTP {} ({} ms)".format(code, elapsed_ms)

    def _poll_once(self):
        for svc in self.cfg.get("services", []):
            name = svc.get("name") or svc.get("url")
            status, message = self._check(svc)
            prev = self._last_status.get(name)
            if status != prev:
                # State change -> always emit so the feed shows transitions.
                self.log.add(status, name, message)
                self._last_status[name] = status
            # else: steady state, stay quiet to avoid flooding the feed.

    def run(self):
        self.log.add("info", "Agent Online", "Vigil intranet agent started, polling services...")
        interval = self.cfg.get("poll_interval_seconds", 30)
        while not self._stop.is_set():
            try:
                self._poll_once()
            except Exception as e:  # never let the loop die
                self.log.add("warn", "Monitor Error", str(e))
            self._stop.wait(interval)


class WebhookPusher(threading.Thread):
    """Optional: POST new events to a public relay URL."""

    daemon = True

    def __init__(self, config, log):
        super().__init__(name="vigil-pusher")
        self.cfg = config
        self.log = log
        self._stop = threading.Event()
        self._seen = 0

    def stop(self):
        self._stop.set()

    def run(self):
        url = self.cfg.get("webhook_url")
        if not url:
            return
        while not self._stop.is_set():
            events = self.log.snapshot()
            new = events[self._seen:]
            if new:
                payload = json.dumps(new).encode("utf-8")
                req = urllib.request.Request(
                    url, data=payload, method="POST",
                    headers={"Content-Type": "application/json", "User-Agent": "vigil-agent/1.0"},
                )
                try:
                    urllib.request.urlopen(req, timeout=self.cfg.get("request_timeout_seconds", 5))
                    self._seen = len(events)
                except Exception:
                    pass  # retry the same batch next tick
            self._stop.wait(min(self.cfg.get("poll_interval_seconds", 30), 10))


def make_handler(config, log):
    token = (config.get("auth_token") or "").strip()

    class Handler(BaseHTTPRequestHandler):
        server_version = "VigilAgent/1.0"

        def log_message(self, *args):
            pass  # quiet by default

        def _cors(self):
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
            self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")

        def _json(self, code, obj):
            body = json.dumps(obj).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self._cors()
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _authorized(self):
            if not token:
                return True
            # Accept ?token= or Authorization: Bearer
            from urllib.parse import urlparse, parse_qs
            q = parse_qs(urlparse(self.path).query)
            if q.get("token", [""])[0] == token:
                return True
            auth = self.headers.get("Authorization", "")
            return auth == "Bearer " + token

        def do_OPTIONS(self):
            self.send_response(204)
            self._cors()
            self.end_headers()

        def do_GET(self):
            path = self.path.split("?", 1)[0]
            if path in ("/events", "/"):
                if not self._authorized():
                    return self._json(401, {"error": "unauthorized"})
                return self._json(200, log.snapshot())
            if path == "/health":
                return self._json(200, {"status": "ok", "time": now_iso()})
            return self._json(404, {"error": "not found"})

    return Handler


def load_config(path):
    cfg = dict(DEFAULT_CONFIG)
    if path and os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            user = json.load(f)
        cfg.update(user)
    return cfg


def main():
    ap = argparse.ArgumentParser(description="Vigil intranet monitoring agent")
    ap.add_argument("--config", default="config.json", help="path to config JSON")
    ap.add_argument("--port", type=int, help="override bind port")
    args = ap.parse_args()

    cfg = load_config(args.config)
    if args.port:
        cfg["bind_port"] = args.port

    log = EventLog(cfg.get("event_buffer_size", 200))

    monitor = Monitor(cfg, log)
    monitor.start()

    pusher = None
    if cfg.get("webhook_url"):
        pusher = WebhookPusher(cfg, log)
        pusher.start()

    host = cfg.get("bind_host", "0.0.0.0")
    port = int(cfg.get("bind_port", 8787))
    httpd = ThreadingHTTPServer((host, port), make_handler(cfg, log))

    print("Vigil agent listening on http://{}:{}/events".format(host, port))
    print("Monitoring {} service(s) every {}s".format(
        len(cfg.get("services", [])), cfg.get("poll_interval_seconds", 30)))
    if cfg.get("webhook_url"):
        print("Pushing events to webhook: {}".format(cfg["webhook_url"]))
    print("Point the dashboard's webhook box at this /events URL (or your relay).")

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down...")
    finally:
        monitor.stop()
        if pusher:
            pusher.stop()
        httpd.shutdown()


if __name__ == "__main__":
    sys.exit(main())
