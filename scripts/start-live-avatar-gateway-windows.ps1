param(
  [string]$Python = "py"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$repoRoot = Split-Path $PSScriptRoot -Parent
$serviceDir = Join-Path $repoRoot "services\avatar_live"
$venvPython = Join-Path $serviceDir ".venv\Scripts\python.exe"

if (-not $env:NEXUS_LIVE_AVATAR_SERVER_TOKEN) {
  throw "Set NEXUS_LIVE_AVATAR_SERVER_TOKEN to the same server-only token used by Agent Hub."
}
if (-not $env:NEXUS_LIVE_AVATAR_WORKER_URL -or -not $env:NEXUS_LIVE_AVATAR_WORKER_TOKEN) {
  Write-Warning "No persistent neural worker is configured. Gateway will report NOT_CONFIGURED and reject sessions."
}

if (-not (Test-Path $venvPython)) {
  & $Python -3.11 -m venv (Join-Path $serviceDir ".venv")
  if ($LASTEXITCODE -ne 0) { throw "Could not create the Python 3.11 live gateway environment." }
}

& $venvPython -m pip install -r (Join-Path $serviceDir "requirements.txt")
if ($LASTEXITCODE -ne 0) { throw "Could not install live gateway dependencies." }

Set-Location $repoRoot
& $venvPython (Join-Path $serviceDir "nexus_live_avatar_server.py")
if ($LASTEXITCODE -ne 0) { throw "The live avatar gateway exited with code $LASTEXITCODE." }
