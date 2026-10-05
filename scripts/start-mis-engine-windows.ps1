param(
  [int]$HubPort = 8788,
  [int]$UiPort = 5173,
  [switch]$NoUi,
  [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Step([string]$m) {
  Write-Host ""
  Write-Host ("=== " + $m + " ===") -ForegroundColor Cyan
}

function UserEnv([string]$name) {
  return [Environment]::GetEnvironmentVariable($name, "User")
}

function Wait-JsonHealth([string]$url, [hashtable]$headers = @{}, [int]$attempts = 80) {
  for ($i = 0; $i -lt $attempts; $i++) {
    Start-Sleep -Milliseconds 500
    try {
      return Invoke-RestMethod -Uri $url -Headers $headers -TimeoutSec 3
    } catch {}
  }
  return $null
}

if ($env:OS -ne "Windows_NT") { throw "Ten starter jest przygotowany dla Windows." }

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$avatarSetup = Join-Path $PSScriptRoot "connect-avatar-server-windows.ps1"
$alignerSetup = Join-Path $PSScriptRoot "setup-mis-aligner-windows.ps1"

if (-not (Test-Path $avatarSetup)) { throw "Brak $avatarSetup" }
if (-not (Test-Path $alignerSetup)) { throw "Brak $alignerSetup" }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "Brak Node.js." }
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw "Brak npm." }

Step "1/5 FasterLivePortrait animal"
& powershell -NoProfile -ExecutionPolicy Bypass -File $avatarSetup
if ($LASTEXITCODE -ne 0) { throw "Nie udalo sie uruchomic FasterLivePortrait." }

$env:NEXUS_AVATAR_SERVER_URL = UserEnv "NEXUS_AVATAR_SERVER_URL"
$env:NEXUS_AVATAR_SERVER_TOKEN = UserEnv "NEXUS_AVATAR_SERVER_TOKEN"
$env:FASTER_LIVEPORTRAIT_DIR = UserEnv "FASTER_LIVEPORTRAIT_DIR"
$env:NEXUS_AVATAR_SUBJECT_MODE = "animal"

if ([string]::IsNullOrWhiteSpace($env:NEXUS_AVATAR_SERVER_URL) -or [string]::IsNullOrWhiteSpace($env:NEXUS_AVATAR_SERVER_TOKEN)) {
  throw "Avatar server nie zapisal konfiguracji."
}

Step "2/5 Phoneme aligner PL / EN / DE"
& powershell -NoProfile -ExecutionPolicy Bypass -File $alignerSetup
if ($LASTEXITCODE -ne 0) { throw "Nie udalo sie uruchomic Miś Phoneme Aligner." }

$env:MIS_ALIGNER_URL = UserEnv "MIS_ALIGNER_URL"
$env:MIS_ALIGNER_TOKEN = UserEnv "MIS_ALIGNER_TOKEN"
if ([string]::IsNullOrWhiteSpace($env:MIS_ALIGNER_URL)) {
  throw "Aligner nie zapisal MIS_ALIGNER_URL."
}

Step "3/5 Agent Hub"
$env:NEXUS_AGENT_HUB_PORT = "$HubPort"
$env:NEXUS_AGENT_HUB_HOST = "127.0.0.1"
$allowed = @(
  "http://127.0.0.1:$UiPort",
  "http://localhost:$UiPort",
  "http://127.0.0.1:4173",
  "http://localhost:4173"
) -join ","
$env:NEXUS_AGENT_HUB_ALLOWED_ORIGINS = $allowed

Set-Location $repoRoot
if (-not (Test-Path (Join-Path $repoRoot "node_modules"))) {
  Write-Host "npm ci..."
  npm ci
  if ($LASTEXITCODE -ne 0) { throw "npm ci failed." }
}

$hubUrl = "http://127.0.0.1:$HubPort"
$hubReady = $false
try {
  $health = Invoke-RestMethod -Uri "$hubUrl/api/health" -TimeoutSec 2
  if ($health.ok) { $hubReady = $true }
} catch {}

if (-not $hubReady) {
  $hubCommand = "Set-Location `"$repoRoot`"; npm run hub"
  Start-Process powershell -ArgumentList @("-NoProfile", "-Command", $hubCommand) -WorkingDirectory $repoRoot | Out-Null
  $health = Wait-JsonHealth "$hubUrl/api/health"
  if (-not $health -or -not $health.ok) { throw "Agent Hub nie wystartowal na $hubUrl." }
}
Write-Host "Agent Hub -> $hubUrl" -ForegroundColor Green

Step "4/5 Miś Engine health"
$mis = Wait-JsonHealth "$hubUrl/api/mis/health" @{} 20
if (-not $mis) { throw "Brak odpowiedzi /api/mis/health." }
if (-not $mis.aligner.ok) {
  throw ("Phoneme aligner NOT READY: " + $mis.aligner.message)
}
if (-not $mis.renderer.live.ok) {
  throw ("LIVE renderer NOT READY: " + $mis.renderer.live.message)
}
Write-Host "Aligner: OK" -ForegroundColor Green
Write-Host "LIVE FasterLivePortrait animal: OK" -ForegroundColor Green
if ($mis.renderer.quality.ok) {
  Write-Host "QUALITY FLP+LTX: OK" -ForegroundColor Green
} else {
  Write-Host "QUALITY FLP+LTX: opcjonalny / nieaktywny" -ForegroundColor Yellow
}

if (-not $NoUi) {
  Step "5/5 UI"
  $uiUrl = "http://127.0.0.1:$UiPort"
  $uiReady = $false
  try {
    $response = Invoke-WebRequest -Uri $uiUrl -UseBasicParsing -TimeoutSec 2
    if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) { $uiReady = $true }
  } catch {}

  if (-not $uiReady) {
    $uiCommand = "Set-Location `"$repoRoot`"; npm run dev -- --port $UiPort"
    Start-Process powershell -ArgumentList @("-NoProfile", "-Command", $uiCommand) -WorkingDirectory $repoRoot | Out-Null
    for ($i = 0; $i -lt 80; $i++) {
      Start-Sleep -Milliseconds 500
      try {
        $response = Invoke-WebRequest -Uri $uiUrl -UseBasicParsing -TimeoutSec 2
        if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) { $uiReady = $true; break }
      } catch {}
    }
    if (-not $uiReady) { throw "UI nie wystartowal na $uiUrl." }
  }

  Write-Host ""
  Write-Host "MIŚ ENGINE TEST GOTOWY" -ForegroundColor Green
  Write-Host "Otworz: $uiUrl" -ForegroundColor Green
  Write-Host "W panelu Miś Engine wybierz zdjęcie, audio, wpisz dokładny tekst i kliknij Renderuj misia." -ForegroundColor Cyan
  if (-not $NoBrowser) { Start-Process $uiUrl }
} else {
  Write-Host ""
  Write-Host "MIŚ ENGINE BACKEND GOTOWY" -ForegroundColor Green
}
