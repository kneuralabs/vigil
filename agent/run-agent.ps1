# Vigil - intranet agent setup (Windows).
#
# QUICK (default): zero-config, ephemeral URL.
#     irm https://vigil.kneuralabs.com/agent/run-agent.ps1 | iex
#
# PERMANENT: stable named Cloudflare tunnel on a hostname you own. Save the file
# first, then run with parameters (param passing doesn't work through `| iex`):
#     irm https://vigil.kneuralabs.com/agent/run-agent.ps1 -OutFile run-agent.ps1
#     ./run-agent.ps1 -Permanent -Hostname agent.kneuralabs.com
param(
  [switch]$Permanent,
  [string]$Hostname,
  [string]$Name = 'vigil-agent',
  [string]$Port = $(if ($env:VIGIL_PORT) { $env:VIGIL_PORT } else { '8787' })
)
$ErrorActionPreference = 'Stop'
$Dashboard = 'https://vigil.kneuralabs.com'
$Base = if ($env:VIGIL_AGENT_BASE) { $env:VIGIL_AGENT_BASE } else { "$Dashboard/agent" }
$Work = Join-Path $env:USERPROFILE '.vigil-agent'
New-Item -ItemType Directory -Force -Path $Work | Out-Null
Set-Location $Work
function Say($m){ Write-Host "[vigil] $m" -ForegroundColor Cyan }

# 1) Python
$py = Get-Command python -ErrorAction SilentlyContinue
if (-not $py) { $py = Get-Command python3 -ErrorAction SilentlyContinue }
if (-not $py) {
  Write-Host "[vigil] Python 3 is required. Install from https://www.python.org/downloads/ (tick 'Add python.exe to PATH'), then re-run." -ForegroundColor Red
  return
}
Say "Using Python: $($py.Source)"

# 2) Agent + config
Say "Downloading the monitoring agent..."
Invoke-WebRequest "$Base/vigil_agent.py" -OutFile vigil_agent.py
if (-not (Test-Path config.json)) {
  Invoke-WebRequest "$Base/config.example.json" -OutFile config.json
  Say "Created config.json - edit it later to list your own services."
}

# 3) cloudflared
$cf = Get-Command cloudflared -ErrorAction SilentlyContinue
if ($cf) { $cfPath = $cf.Source } else {
  Say "Downloading cloudflared..."
  $arch = if ([Environment]::Is64BitOperatingSystem) { 'amd64' } else { '386' }
  Invoke-WebRequest "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-$arch.exe" -OutFile cloudflared.exe
  $cfPath = (Resolve-Path cloudflared.exe).Path
}
Say "Using cloudflared: $cfPath"

# 4) Start the agent
Say "Starting the agent on port $Port..."
$agent = Start-Process -FilePath $py.Source -ArgumentList 'vigil_agent.py','--config','config.json','--port',$Port `
  -PassThru -WindowStyle Hidden -RedirectStandardOutput agent.log -RedirectStandardError agent.err

function Announce($events){
  $link = "$Dashboard/?agent=$events"
  Write-Host ""
  Say "=================================================="
  Say "  Your intranet agent is LIVE and connected."
  Say "=================================================="
  Write-Host ""
  Say "Open this link - the dashboard connects automatically:"
  Write-Host "    $link" -ForegroundColor Green
  Write-Host ""
  Say "(Or paste this into the dashboard's box manually:)"
  Write-Host "    $events"
  Write-Host ""
  Start-Process $link
}

if (-not $Permanent) {
  # ---- QUICK tunnel ----
  Say "Opening a secure quick tunnel (ephemeral URL)..."
  if (Test-Path tunnel.log) { Remove-Item tunnel.log -Force }
  $tunnel = Start-Process -FilePath $cfPath -ArgumentList 'tunnel','--url',"http://localhost:$Port" `
    -PassThru -WindowStyle Hidden -RedirectStandardOutput tunnel.log -RedirectStandardError tunnel.err
  $url = $null
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Seconds 1
    $txt = (Get-Content tunnel.log, tunnel.err -ErrorAction SilentlyContinue) -join "`n"
    $m = [regex]::Match($txt, 'https://[a-z0-9.-]+\.trycloudflare\.com')
    if ($m.Success) { $url = $m.Value; break }
    if ($agent.HasExited) { Write-Host "[vigil] Agent failed to start - see $Work\agent.err" -ForegroundColor Red; return }
  }
  if (-not $url) { Write-Host "[vigil] Could not obtain a tunnel URL - see $Work\tunnel.log" -ForegroundColor Red; return }
  Announce "$url/events"
  Say "Quick-tunnel URL is temporary. For a stable URL: -Permanent -Hostname <your-host>"
  Say "Close this window to stop monitoring."
  try { Wait-Process -Id $agent.Id } finally { Stop-Process -Id $agent.Id, $tunnel.Id -ErrorAction SilentlyContinue }
  return
}

# ---- PERMANENT: named tunnel on a hostname you own ----
if (-not $Hostname) {
  Write-Host "[vigil] -Permanent requires -Hostname <host> (a name in a domain on your Cloudflare account)." -ForegroundColor Red
  Stop-Process -Id $agent.Id -ErrorAction SilentlyContinue; return
}
$cert = Join-Path $env:USERPROFILE '.cloudflared\cert.pem'
if (-not (Test-Path $cert)) {
  Say "One-time Cloudflare login - a browser opens; pick the domain that owns $Hostname."
  & $cfPath tunnel login
}
$tid = $null
try { $tid = (& $cfPath tunnel list --output json | ConvertFrom-Json | Where-Object { $_.name -eq $Name } | Select-Object -First 1).id } catch {}
if (-not $tid) {
  Say "Creating named tunnel '$Name'..."
  & $cfPath tunnel create $Name
  try { $tid = (& $cfPath tunnel list --output json | ConvertFrom-Json | Where-Object { $_.name -eq $Name } | Select-Object -First 1).id } catch {}
}
if (-not $tid) { Write-Host "[vigil] Could not create/find tunnel '$Name'." -ForegroundColor Red; Stop-Process -Id $agent.Id -ErrorAction SilentlyContinue; return }
Say "Tunnel '$Name' id: $tid"

$cred = Join-Path $env:USERPROFILE ".cloudflared\$tid.json"
$cfg = Join-Path $Work 'cloudflared-config.yml'
@"
tunnel: $tid
credentials-file: $cred
ingress:
  - hostname: $Hostname
    service: http://localhost:$Port
  - service: http_status:404
"@ | Set-Content -Path $cfg -Encoding ascii
Say "Wrote tunnel config: $cfg"

Say "Routing DNS $Hostname -> tunnel..."
try { & $cfPath tunnel route dns $Name $Hostname } catch { Say "(DNS route may already exist - continuing.)" }

Announce "https://$Hostname/events"
Say "Stable URL - it stays the same across restarts."
Say "Tip: 'cloudflared service install' + a startup task for the agent keeps it running 24/7."
Say "Running in the foreground now. Close this window to stop."
& $cfPath tunnel --config $cfg run $Name
