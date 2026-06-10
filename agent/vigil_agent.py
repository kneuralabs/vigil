#!/usr/bin/env python3
"""
Vigil Intranet Agent
====================

A tiny, dependency-free monitoring agent you run *inside* your private network
(e.g. on a box that can reach intranet.kneuralabs.com). It periodically
health-checks your internal services, captures their **real HTTP status codes**
and latency, runs anomaly / breach detection, and exposes everything to the
Vigil dashboard.

Endpoints (all CORS-enabled, GET):

  /events   Rolling event log in the dashboard's shape:
            [{"type":"ok|info|warn|crit","title","message","time","ts",
              "service","code","latency_ms","category","kind"}]
            (extra keys are ignored by older dashboards)

  /status   Live per-service snapshot with real status codes + flags:
            {"generated":"...","services":[
                {"name","url","code","category","latency_ms","checked","flags":[...]}
             ],"alerts":[ ... active security/anomaly flags ... ]}

  /health   {"status":"ok"} liveness probe.

Delivery to the dashboard:
  PULL  - expose this agent (e.g. `cloudflared tunnel --url http://localhost:8787`)
          and paste the .../events URL into the dashboard. The dashboard also
          reads .../status to render real status codes per service.
  PUSH  - set "webhook_url" to POST events to a public relay you control.

Standard library only. Python 3.7+. No pip install.

Usage:
    python3 vigil_agent.py --config config.json
"""

import argparse
import json
import os
import socket
import ssl
import statistics
import sys
import threading
import time
import urllib.error
import urllib.request
from collections import deque
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

DEFAULT_CONFIG = {
    "bind_host": "0.0.0.0",
    "bind_port": 8787,
    "poll_interval_seconds": 30,
    "request_timeout_seconds": 5,
    "slow_threshold_ms": 1500,
    "event_buffer_size": 200,
    "verify_tls": True,
    "auth_token": "",
    "webhook_url": "",
    # --- anomaly / breach detection tunables ---
    "latency_anomaly_floor_ms": 800,   # ignore spikes below this absolute floor
    "latency_anomaly_factor": 3.0,     # spike = latency > factor * baseline median
    "auth_failure_burst": 3,           # >= this many 401/403 in one cycle -> breach flag
    "server_error_storm": 3,           # >= this many 5xx in one cycle -> breach flag
    "cert_min_days": 14,               # warn when a TLS cert expires within N days
    # services: {name, url, [expect_status]}.
    # expect_status lets you assert a route's expected code; a mismatch is flagged
    # (e.g. expect_status 401 on a protected API -> a 200 is a possible auth bypass).
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

    def add(self, etype, title, message, **extra):
        evt = {"type": etype, "title": title, "message": message,
               "time": hhmmss(), "ts": now_iso()}
        evt.update(extra)
        with self._lock:
            self._events.append(evt)
        return evt

    def snapshot(self):
        with self._lock:
            return list(self._events)


class ServiceState:
    """Latest health + rolling history for one monitored service."""

    def __init__(self, name, url, expect_status=None):
        self.name = name
        self.url = url
        self.expect_status = expect_status
        self.code = None
        self.category = None
        self.latency_ms = None
        self.checked = None
        self.flags = []                 # active flags from the most recent cycle
        self.lat_hist = deque(maxlen=20)
        self.was_anomalous = False          # throttles repeated latency-anomaly events
        self.expect_violation_active = False  # throttles repeated expect_status events

    def to_dict(self):
        return {
            "name": self.name,
            "url": self.url,
            "code": self.code,
            "category": self.category,
            "latency_ms": self.latency_ms,
            "checked": self.checked,
            "flags": list(self.flags),
        }


def categorize(code, latency_ms, slow_ms):
    """Map a raw HTTP result to a dashboard category + short note."""
    if code == 0:
        return "crit", "unreachable"
    if code >= 500:
        return "crit", "server error"
    if code in (401, 403):
        return "warn", "auth-gated"
    if code >= 400:
        return "warn", "client error"
    if latency_ms is not None and latency_ms > slow_ms:
        return "warn", "slow"
    return "ok", "ok"


class Monitor(threading.Thread):
    """Background poller: health checks, status codes, anomaly + breach flags."""

    daemon = True

    def __init__(self, config, log):
        super().__init__(name="vigil-monitor")
        self.cfg = config
        self.log = log
        self.services = [
            ServiceState(s.get("name") or s.get("url"), s["url"], s.get("expect_status"))
            for s in config.get("services", [])
        ]
        self._stop = threading.Event()
        self._auth_burst_active = False
        self._error_storm_active = False
        self._cert_flagged = {}  # url -> bool, throttles cert events
        self._lock = threading.Lock()
        if config.get("verify_tls", True):
            self._ssl_ctx = ssl.create_default_context()
        else:
            self._ssl_ctx = ssl._create_unverified_context()

    def stop(self):
        self._stop.set()

    def status_snapshot(self):
        with self._lock:
            services = [s.to_dict() for s in self.services]
        alerts = []
        for s in services:
            for f in s["flags"]:
                alerts.append(s["name"] + ": " + f)
        if self._auth_burst_active:
            alerts.insert(0, "BREACH SIGNAL: auth-failure burst across services")
        if self._error_storm_active:
            alerts.insert(0, "BREACH SIGNAL: server-error storm across services")
        return {"generated": now_iso(), "services": services, "alerts": alerts}

    # ---- individual checks -------------------------------------------------
    def _http_check(self, url):
        """Return (code, latency_ms). code == 0 means unreachable."""
        timeout = self.cfg.get("request_timeout_seconds", 5)
        req = urllib.request.Request(url, method="GET",
                                     headers={"User-Agent": "vigil-agent/1.1"})
        start = time.monotonic()
        try:
            with urllib.request.urlopen(req, timeout=timeout, context=self._ssl_ctx) as resp:
                return resp.getcode(), int((time.monotonic() - start) * 1000)
        except urllib.error.HTTPError as e:
            return e.code, int((time.monotonic() - start) * 1000)
        except (urllib.error.URLError, TimeoutError, OSError):
            return 0, int((time.monotonic() - start) * 1000)

    def _cert_days_left(self, url):
        """Best-effort TLS cert lifetime in days for https URLs (None if unknown)."""
        p = urlparse(url)
        if p.scheme != "https":
            return None
        host = p.hostname
        port = p.port or 443
        try:
            ctx = ssl.create_default_context()
            with socket.create_connection((host, port),
                                          timeout=self.cfg.get("request_timeout_seconds", 5)) as sock:
                with ctx.wrap_socket(sock, server_hostname=host) as ss:
                    cert = ss.getpeercert()
            na = cert.get("notAfter")
            if not na:
                return None
            exp = datetime.strptime(na, "%b %d %H:%M:%S %Y %Z").replace(tzinfo=timezone.utc)
            return (exp - datetime.now(timezone.utc)).days
        except Exception:
            return None  # self-signed / handshake issue -> skip silently

    # ---- main cycle --------------------------------------------------------
    def _poll_once(self):
        slow = self.cfg.get("slow_threshold_ms", 1500)
        floor = self.cfg.get("latency_anomaly_floor_ms", 800)
        factor = self.cfg.get("latency_anomaly_factor", 3.0)
        auth_fail = 0
        server_err = 0

        for svc in self.services:
            # Isolate each service's check: one failing service (e.g. an
            # exception in cert checking) must not abort the rest of the cycle.
            try:
                self._check_service(svc, slow, floor, factor)
            except Exception as e:
                self.log.add("warn", "Monitor Error · " + svc.name,
                             "check failed: %s" % e,
                             service=svc.name, category="warn", kind="status")
                continue
            if svc.code in (401, 403):
                auth_fail += 1
            if svc.code is not None and svc.code >= 500:
                server_err += 1

        self._breach_signals(auth_fail, server_err)

    def _check_service(self, svc, slow, floor, factor):
        code, latency = self._http_check(svc.url)
        category, note = categorize(code, latency, slow)
        flags = []

        prev_code = svc.code
        prev_cat = svc.category

        # availability / status-code transitions
        if prev_cat is None:
            self.log.add(category, svc.name,
                         ("unreachable" if code == 0 else "HTTP %d" % code) +
                         " (%d ms)" % latency,
                         service=svc.name, code=code, latency_ms=latency,
                         category=category, kind="status")
        elif category != prev_cat or code != prev_code:
            msg = ("now unreachable" if code == 0 else "HTTP %d (%s)" % (code, note)) + \
                  " — was %s" % ("unreachable" if prev_code == 0 else "HTTP %d" % prev_code)
            self.log.add(category, svc.name, msg + " · %d ms" % latency,
                         service=svc.name, code=code, latency_ms=latency,
                         category=category, kind="status")

        # latency-spike anomaly (needs a baseline)
        if code != 0 and len(svc.lat_hist) >= 5:
            baseline = statistics.median(svc.lat_hist)
            threshold = max(floor, factor * baseline)
            if latency > threshold:
                if not svc.was_anomalous:
                    flags.append("latency spike %dms (baseline ~%dms)" % (latency, int(baseline)))
                    self.log.add("warn", "⚠ Anomaly · " + svc.name,
                                 "Latency spike: %d ms vs baseline ~%d ms — possible resource exhaustion/DoS"
                                 % (latency, int(baseline)),
                                 service=svc.name, code=code, latency_ms=latency,
                                 category="warn", kind="anomaly")
                svc.was_anomalous = True
            else:
                svc.was_anomalous = False
        if code != 0:
            svc.lat_hist.append(latency)

        # expected-status assertion (config-driven breach/anomaly signal)
        if svc.expect_status is not None:
            if code == svc.expect_status:
                svc.expect_violation_active = False
            elif svc.expect_status in (401, 403) and code == 200:
                flags.append("expected %d, got 200 (possible auth bypass/exposure)" % svc.expect_status)
                if not svc.expect_violation_active:
                    self.log.add("crit", "\U0001F6A8 Security · " + svc.name,
                                 "Protected route expected HTTP %d but returned 200 — possible authentication bypass or data exposure."
                                 % svc.expect_status,
                                 service=svc.name, code=code, latency_ms=latency,
                                 category="crit", kind="security")
                svc.expect_violation_active = True
            elif code != 0:
                flags.append("expected %d, got %d" % (svc.expect_status, code))
                svc.expect_violation_active = False

        # cert expiry (best effort, throttled)
        days = self._cert_days_left(svc.url)
        if days is not None:
            cert_min = self.cfg.get("cert_min_days", 14)
            if days < cert_min:
                flags.append("TLS cert expires in %d days" % days)
                if not self._cert_flagged.get(svc.url):
                    sev = "crit" if days < 3 else "warn"
                    self.log.add(sev, "⚠ Anomaly · " + svc.name,
                                 "TLS certificate expires in %d day(s)." % days,
                                 service=svc.name, code=code, latency_ms=latency,
                                 category=sev, kind="anomaly")
                self._cert_flagged[svc.url] = True
            else:
                self._cert_flagged[svc.url] = False

        with self._lock:
            svc.code = code
            svc.category = category
            svc.latency_ms = latency
            svc.checked = now_iso()
            svc.flags = flags

    def _breach_signals(self, auth_fail, server_err):
        # Auth-failure burst (possible credential-stuffing / brute force).
        if auth_fail >= self.cfg.get("auth_failure_burst", 3):
            if not self._auth_burst_active:
                self.log.add("crit", "\U0001F6A8 Security · Auth Failure Burst",
                             "%d services returned 401/403 this cycle — possible credential attack or auth outage."
                             % auth_fail, kind="security", category="crit")
            self._auth_burst_active = True
        else:
            self._auth_burst_active = False
        # Server-error storm (possible attack / cascading failure).
        if server_err >= self.cfg.get("server_error_storm", 3):
            if not self._error_storm_active:
                self.log.add("crit", "\U0001F6A8 Security · Server Error Storm",
                             "%d services returned 5xx this cycle — possible attack or cascading outage."
                             % server_err, kind="security", category="crit")
            self._error_storm_active = True
        else:
            self._error_storm_active = False

    def run(self):
        self.log.add("info", "Agent Online",
                     "Vigil agent started — monitoring %d service(s)." % len(self.services),
                     kind="status")
        interval = self.cfg.get("poll_interval_seconds", 30)
        while not self._stop.is_set():
            try:
                self._poll_once()
            except Exception as e:
                self.log.add("warn", "Monitor Error", str(e), kind="status")
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
                    headers={"Content-Type": "application/json", "User-Agent": "vigil-agent/1.1"})
                try:
                    urllib.request.urlopen(req, timeout=self.cfg.get("request_timeout_seconds", 5))
                    self._seen = len(events)
                except Exception:
                    pass
            self._stop.wait(min(self.cfg.get("poll_interval_seconds", 30), 10))


def make_handler(config, log, monitor):
    token = (config.get("auth_token") or "").strip()

    class Handler(BaseHTTPRequestHandler):
        server_version = "VigilAgent/1.1"

        def log_message(self, *args):
            pass

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
            q = parse_qs(urlparse(self.path).query)
            if q.get("token", [""])[0] == token:
                return True
            return self.headers.get("Authorization", "") == "Bearer " + token

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
            if path == "/status":
                if not self._authorized():
                    return self._json(401, {"error": "unauthorized"})
                return self._json(200, monitor.status_snapshot())
            if path == "/health":
                return self._json(200, {"status": "ok", "time": now_iso()})
            return self._json(404, {"error": "not found"})

    return Handler


def load_config(path):
    cfg = dict(DEFAULT_CONFIG)
    if path and os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            cfg.update(json.load(f))
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
    httpd = ThreadingHTTPServer((host, port), make_handler(cfg, log, monitor))

    print("Vigil agent listening on http://{}:{}".format(host, port))
    print("  /events  rolling event log   /status  live per-service codes + flags")
    print("Monitoring {} service(s) every {}s".format(
        len(cfg.get("services", [])), cfg.get("poll_interval_seconds", 30)))
    # Startup configuration summary (never prints secret values).
    print("Config: tls_verify={} auth_token={} webhook={} event_buffer={}".format(
        "on" if cfg.get("verify_tls", True) else "OFF (insecure)",
        "yes" if (cfg.get("auth_token") or "").strip() else "no",
        "yes" if cfg.get("webhook_url") else "no",
        cfg.get("event_buffer_size", 200)))
    print("Thresholds: slow={}ms latency_floor={}ms latency_factor={} "
          "auth_burst={} error_storm={} cert_min_days={}".format(
        cfg.get("slow_threshold_ms", 1500),
        cfg.get("latency_anomaly_floor_ms", 800),
        cfg.get("latency_anomaly_factor", 3.0),
        cfg.get("auth_failure_burst", 3),
        cfg.get("server_error_storm", 3),
        cfg.get("cert_min_days", 14)))
    if cfg.get("webhook_url"):
        print("Pushing events to webhook: {}".format(cfg["webhook_url"]))

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
