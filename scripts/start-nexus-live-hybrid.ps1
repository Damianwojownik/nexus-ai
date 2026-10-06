param(
  [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$Root = Split-Path -Parent $PSScriptRoot
$LocalConfig = Join-Path $Root ".nexus-live.local.ps1"
if (Test-Path -LiteralPath $LocalConfig) {
  . $LocalConfig
}
$GatewayScript = Join-Path $PSScriptRoot "start-live-avatar-gateway-windows.ps1"
$NexusScript = Join-Path $PSScriptRoot "start-nexus-windows.ps1"

function Test-AuthenticatedHealth {
  try {
    $headers = @{ Authorization = "Bearer $($env:NEXUS_LIVE_AVATAR_SERVER_TOKEN)" }
    return Invoke-RestMethod -Uri "http://127.0.0.1:9873/v1/live/health" -Headers $headers -TimeoutSec 3
  } catch {
    return $null
  }
}

if (-not $env:NEXUS_LIVE_AVATAR_SERVER_TOKEN) {
  throw "Set NEXUS_LIVE_AVATAR_SERVER_TOKEN to a long local gateway secret."
}
if (-not $env:NEXUS_LIVE_AVATAR_WORKER_URL) {
  throw "Set NEXUS_LIVE_AVATAR_WORKER_URL to the installed worker, for example https://<worker-host>."
}
if (-not $env:NEXUS_LIVE_AVATAR_WORKER_TOKEN) {
  throw "Set NEXUS_LIVE_AVATAR_WORKER_TOKEN to the worker secret."
}

$env:NEXUS_LIVE_AVATAR_SERVER_URL = "http://127.0.0.1:9873"
$env:NEXUS_LIVE_AVATAR_CONTROL_URL_BASE = "ws://127.0.0.1:9873"

$health = Test-AuthenticatedHealth
if (-not $health) {
  $listener = Get-NetTCPConnection -LocalPort 9873 -State Listen -ErrorAction SilentlyContinue
  if ($listener) {
    throw "Port 9873 is occupied but the Nexus live gateway did not answer authenticated health."
  }

  $gatewayArgs = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ('"' + $GatewayScript + '"'))
  $gateway = Start-Process -FilePath "powershell.exe" -ArgumentList $gatewayArgs -WorkingDirectory $Root -PassThru

  for ($attempt = 0; $attempt -lt 120; $attempt++) {
    Start-Sleep -Milliseconds 500
    $gateway.Refresh()
    if ($gateway.HasExited) {
      throw "Nexus live gateway exited with code $($gateway.ExitCode)."
    }
    $health = Test-AuthenticatedHealth
    if ($health) { break }
  }
  if (-not $health) { throw "Nexus live gateway did not become responsive." }
}

Write-Host "Live gateway status:"
$health | ConvertTo-Json -Depth 6

if (-not $health.available) {
  Write-Warning ("Neural worker is not live-ready yet: " + $health.reason)
  Write-Warning "Nexus will still start with the canonical static portrait and local voice."
}

$nexusArgs = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ('"' + $NexusScript + '"'))
if ($NoBrowser) { $nexusArgs += "-NoBrowser" }

& powershell.exe @nexusArgs
exit $LASTEXITCODE
