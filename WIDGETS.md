# Vigil — Widget Summary

Vigil™ is the Kneuralabs *Continuous Surface Watch* dashboard. It runs entirely
from a static page, pulling from free public APIs (crt.sh, Google DoH) and an
optional intranet agent. Below is a summary of every widget on the dashboard.

## Header & global controls
- **Brand / radar mark** — animated Kneuralabs logo with a radar sweep overlay.
- **LIVE badge + clock** — live indicator and a running clock.
- **Theme toggle** — switches dark / light mode.
- **Refresh button** — forces a full re-scan of all checks.

## Command bar
- **Public Surface input** — the public URL to monitor (default `www.kneuralabs.com`).
- **Intranet Target input** — the private/intranet URL to probe.
- **Run Scan button** — kicks off all checks.

## Status bar (KPI stat cards)
Each card shows a value, a KPI track, and a sub-label:
- **Cert Days Left** — days until the TLS certificate expires (crt.sh).
- **DNS Status** — resolution status via Google DoH.
- **CT Log Entries** — count of Certificate Transparency entries (crt.sh).
- **Issuing CA** — the certificate authority that issued the cert.
- **Mail (MX)** — presence/health of MX records.
- **Subdomains Live** — count of auto-enumerated live subdomains.
- **Intranet** — current intranet probe state.

## Monitor terminal
- **vigil-monitor terminal** — a live streaming log styled as a terminal window
  with a WATCHING status pulse.

## 01 · Public Surface
- **SSL / TLS Certificate** (crt.sh) — certificate details and validity.
- **DNS Records** (Google DoH) — resolved DNS records.
- **Certificate Transparency** (crt.sh log) — recent CT log entries.
- **Security Headers** — explains the CORS limitation on header inspection and
  links to free manual verification tools (securityheaders.com, Mozilla
  Observatory, and a `curl -I` snippet).

## 02 · Subdomain Surface
- **Discovered Subdomains** (crt.sh CT log + live probe) — auto-enumerates every
  hostname ever issued a certificate under the domain and probes each for live
  reachability, with a radar animation and per-subdomain reachability list.

## 03 · Intranet
- **Intranet Agent Status** — live reachability probe of the intranet target,
  with a radar animation and per-host status list.
- **Live Scan Event Log** — streaming feed of scan events from public APIs.
- **Connect Intranet Agent** — connection panel for the optional intranet agent:
  a URL input, Connect / Stop buttons, and a connection-status line.
- **Sentinel · Repository Posture** — a full-width panel summarising every
  Kneuralabs repository Sentinel watches, pulled live from the GitHub public API
  (`api.github.com`, no key). Shows headline stats (repositories, stars, open
  issues, archived) and a list of the most recently pushed repos with language,
  stars, last-push time and open-issue count, plus an "Open Sentinel ↗" link to
  the full SSO-gated security scan.

## Tweaks panel (edit-mode appearance controls)
A floating settings panel exposing live theming controls:
- **Theme → Mode** — light / dark radio.
- **Theme → Accent** — accent color picker.
- **Layout → Density** — compact / regular radio.
- **Motion → Animations** — enable/disable animations toggle.
