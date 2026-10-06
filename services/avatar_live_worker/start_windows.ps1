param()

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$WorkerDir = Join-Path $RepoRoot "services\avatar_live_worker"
$Python = Join-Path $WorkerDir ".venv\Scripts\python.exe"

if (-not (Test-Path $Python)) {
  throw "Worker environment missing. Run services\avatar_live_worker\install_windows.ps1 first."
}
if (-not $env:NEXUS_LIVE_AVATAR_WORKER_TOKEN) {
  throw "Set NEXUS_LIVE_AVATAR_WORKER_TOKEN."
}
if (-not $env:NEXUS_MUSETALK_DIR) { $env:NEXUS_MUSETALK_DIR = Join-Path $RepoRoot ".tools\MuseTalk" }
if (-not $env:NEXUS_LIVE_WORKER_HOST) { $env:NEXUS_LIVE_WORKER_HOST = "127.0.0.1" }
if (-not $env:NEXUS_LIVE_WORKER_PORT) { $env:NEXUS_LIVE_WORKER_PORT = "9874" }
if (-not $env:NEXUS_LIVE_RENDER_FPS) { $env:NEXUS_LIVE_RENDER_FPS = "25" }
if (-not $env:NEXUS_LIVE_MAX_SESSIONS) { $env:NEXUS_LIVE_MAX_SESSIONS = "1" }
if (-not $env:NEXUS_LIVE_AUDIO_WINDOW_MS) { $env:NEXUS_LIVE_AUDIO_WINDOW_MS = "480" }

& $Python (Join-Path $WorkerDir "worker.py")
exit $LASTEXITCODE
