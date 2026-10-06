param(
  [Parameter(Mandatory=$true)][string]$Origin,
  [switch]$Restart
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$Root = Split-Path -Parent $PSScriptRoot
$ConfigPath = Join-Path $Root ".nexus-live.local.ps1"
$Launcher = Join-Path $PSScriptRoot "start-nexus-live-hybrid.ps1"

try {
  $uri = [Uri]$Origin
} catch {
  throw "Origin must be a valid absolute HTTPS URL."
}
if ($uri.Scheme -ne "https" -or -not $uri.Host) {
  throw "Origin must use HTTPS."
}
if ($uri.AbsolutePath -ne "/" -or $uri.Query -or $uri.Fragment -or $uri.UserInfo) {
  throw "Pass only the origin, for example https://name.trycloudflare.com"
}
if (-not $uri.Host.EndsWith(".trycloudflare.com", [StringComparison]::OrdinalIgnoreCase)) {
  throw "This helper only accepts an exact Cloudflare Quick Tunnel (*.trycloudflare.com) origin."
}
$normalized = $uri.GetLeftPart([UriPartial]::Authority)

if (-not (Test-Path -LiteralPath $ConfigPath)) {
  throw "Missing $ConfigPath. Run scripts\setup-nexus-live-windows.ps1 first."
}

$lines = Get-Content -LiteralPath $ConfigPath
$assignment = '$env:NEXUS_AGENT_HUB_ALLOWED_ORIGINS = "' + $normalized + '"'
$found = $false
$out = foreach ($line in $lines) {
  if ($line -match '^\s*\$env:NEXUS_AGENT_HUB_ALLOWED_ORIGINS\s*=') {
    $found = $true
    $assignment
  } else {
    $line
  }
}
if (-not $found) {
  $out += $assignment
}
Set-Content -LiteralPath $ConfigPath -Value ($out -join [Environment]::NewLine) -Encoding UTF8

Write-Host "Trusted exact Nexus tunnel origin:"
Write-Host "  $normalized"
Write-Host "Agent Hub remains bound to 127.0.0.1; this does not publish port 8788."

if (-not $Restart) {
  Write-Host "Restart Nexus/Agent Hub so the new origin is loaded:"
  Write-Host "  powershell -ExecutionPolicy Bypass -File scripts\start-nexus-live-hybrid.ps1"
  exit 0
}

$listener = Get-NetTCPConnection -LocalPort 8788 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
  $process = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $listener.OwningProcess) -ErrorAction Stop
  if (-not $process.CommandLine -or $process.CommandLine -notmatch 'agentHubRuntime\.ts') {
    throw "Port 8788 belongs to a process that is not the Nexus Agent Hub; refusing to stop it."
  }
  Write-Host "Restarting Nexus Agent Hub PID $($listener.OwningProcess)..."
  Stop-Process -Id $listener.OwningProcess -Force
  Start-Sleep -Milliseconds 800
}

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Launcher -NoBrowser
exit $LASTEXITCODE
