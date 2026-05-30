# Vigil - one-click intranet agent setup (Windows).
#
# Run this in PowerShell on a machine inside your network:
#
#     irm https://vigil.kneuralabs.com/agent/run-agent.ps1 | iex
#
# It downloads the agent, opens a free secure tunnel (no account needed), and
# opens a link that connects the dashboard automatically.
$ErrorActionPreference = 'Stop'
$Dashboard = 'https://vigil.kneuralabs.com'
$Base = if ($env:VIGIL_AGENT_BASE) { $env:VIGIL_AGENT_BASE } else { "$Dashboard/agent" }
$Port = if ($env:VIGIL_PORT) { $env:VIGIL_PORT } else { '8787' }
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

# 5) Start the tunnel
Say "Opening a secure public tunnel..."
if (Test-Path tunnel.log) { Remove-Item tunnel.log -Force }
$tunnel = Start-Process -FilePath $cfPath -ArgumentList 'tunnel','--url',"http://localhost:$Port" `
  -PassThru -WindowStyle Hidden -RedirectStandardOutput tunnel.log -RedirectStandardError tunnel.err

# 6) Wait for the public URL
$url = $null
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Seconds 1
  $txt = (Get-Content tunnel.log, tunnel.err -ErrorAction SilentlyContinue) -join "`n"
  $m = [regex]::Match($txt, 'https://[a-z0-9.-]+\.trycloudflare\.com')
  if ($m.Success) { $url = $m.Value; break }
  if ($agent.HasExited) { Write-Host "[vigil] Agent failed to start - see $Work\agent.err" -ForegroundColor Red; return }
}
if (-not $url) { Write-Host "[vigil] Could not obtain a tunnel URL - see $Work\tunnel.log" -ForegroundColor Red; return }

$events = "$url/events"
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
Say "Agent running. Close this window to stop monitoring."
try { Wait-Process -Id $agent.Id } finally { Stop-Process -Id $agent.Id, $tunnel.Id -ErrorAction SilentlyContinue }
