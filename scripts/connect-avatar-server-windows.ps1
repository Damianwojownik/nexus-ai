param(
  [string]$InstallDir = (Join-Path $PSScriptRoot "..\\vendor\\FasterLivePortrait"),
  [int]$Port = 9872,
  [switch]$NoStart
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Step([string]$m) {
  Write-Host ""
  Write-Host ("=== " + $m + " ===") -ForegroundColor Cyan
}

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$InstallDir = [IO.Path]::GetFullPath($InstallDir)
$setup = Join-Path $PSScriptRoot "setup-faster-liveportrait-windows.ps1"
$server = Join-Path $repoRoot "services\\avatar_server\\nexus_avatar_server.py"

Step "Sprawdzenie FasterLivePortrait"
if (-not (Test-Path (Join-Path $InstallDir ".venv\\Scripts\\python.exe")) -or -not (Test-Path (Join-Path $InstallDir "configs\\onnx_infer.yaml"))) {
  if (-not (Test-Path $setup)) { throw "Brak instalatora: $setup" }
  & powershell -NoProfile -ExecutionPolicy Bypass -File $setup
}

$python = Join-Path $InstallDir ".venv\\Scripts\\python.exe"
if (-not (Test-Path $python)) { throw "Brak venv FasterLivePortrait: $python" }
if (-not (Test-Path $server)) { throw "Brak serwera Nexus Avatar: $server" }

Step "Zaleznosci serwera Nexus Avatar"
& $python -m pip install --upgrade fastapi uvicorn python-multipart

Step "Konfiguracja bezpiecznego tokenu"
$token = [Environment]::GetEnvironmentVariable("NEXUS_AVATAR_SERVER_TOKEN", "User")
if ([string]::IsNullOrWhiteSpace($token)) {
  $bytes = New-Object byte[] 32
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  $token = -join ($bytes | ForEach-Object { $_.ToString("x2") })
  [Environment]::SetEnvironmentVariable("NEXUS_AVATAR_SERVER_TOKEN", $token, "User")
}

$url = "http://127.0.0.1:$Port"
[Environment]::SetEnvironmentVariable("NEXUS_AVATAR_SERVER_URL", $url, "User")
[Environment]::SetEnvironmentVariable("FASTER_LIVEPORTRAIT_DIR", $InstallDir, "User")
$env:NEXUS_AVATAR_SERVER_URL = $url
$env:NEXUS_AVATAR_SERVER_TOKEN = $token
$env:FASTER_LIVEPORTRAIT_DIR = $InstallDir

Write-Host "NEXUS_AVATAR_SERVER_URL=$url" -ForegroundColor Green
Write-Host "NEXUS_AVATAR_SERVER_TOKEN ustawiony bez wyswietlania sekretu." -ForegroundColor Green

if ($NoStart) {
  Write-Host "Konfiguracja zapisana. Uruchom bez -NoStart, aby wystartowac serwer."
  exit 0
}

Step "Start lokalnego serwera animacji"
$headers = @{ Authorization = "Bearer $token" }
$alreadyRunning = $false
try {
  $health = Invoke-RestMethod -Uri "$url/health" -Headers $headers -TimeoutSec 2
  if ($health.ok) { $alreadyRunning = $true }
} catch {}

if (-not $alreadyRunning) {
  $env:NEXUS_AVATAR_SERVER_PORT = "$Port"
  Start-Process -FilePath $python -ArgumentList @($server, "--host", "127.0.0.1", "--port", "$Port") -WorkingDirectory $repoRoot | Out-Null

  $ok = $false
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 500
    try {
      $health = Invoke-RestMethod -Uri "$url/health" -Headers $headers -TimeoutSec 2
      if ($health.ok) { $ok = $true; break }
    } catch {}
  }
  if (-not $ok) {
    throw "Serwer nie odpowiedzial na $url/health. Sprawdz terminal procesu Python i modele FasterLivePortrait."
  }
}

Step "Polaczone"
Write-Host "Nexus -> $url -> FasterLivePortrait (ONNX)" -ForegroundColor Green
Write-Host "Zamknij i uruchom ponownie Nexus/Agent Hub, aby nowy proces odziedziczyl zmienne srodowiskowe." -ForegroundColor Yellow
Write-Host "Test: GET $url/health z Bearer tokenem zapisanym w NEXUS_AVATAR_SERVER_TOKEN."
