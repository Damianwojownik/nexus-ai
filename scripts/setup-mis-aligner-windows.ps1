param(
  [string]$EnvName = "mis-aligner",
  [int]$Port = 9873,
  [switch]$NoStart
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Step([string]$m) {
  Write-Host ""
  Write-Host ("=== " + $m + " ===") -ForegroundColor Cyan
}

function Find-Conda {
  $command = Get-Command conda.exe -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }

  $candidates = @(
    (Join-Path $env:USERPROFILE "miniforge3\Scripts\conda.exe"),
    (Join-Path $env:LOCALAPPDATA "miniforge3\Scripts\conda.exe"),
    "C:\ProgramData\miniforge3\Scripts\conda.exe",
    (Join-Path $env:USERPROFILE "Miniconda3\Scripts\conda.exe"),
    (Join-Path $env:LOCALAPPDATA "Miniconda3\Scripts\conda.exe"),
    "C:\ProgramData\Miniconda3\Scripts\conda.exe"
  )
  foreach ($candidate in $candidates) {
    if (Test-Path $candidate) { return $candidate }
  }
  return $null
}

function New-RandomToken {
  $bytes = New-Object byte[] 32
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  return -join ($bytes | ForEach-Object { $_.ToString("x2") })
}

if ($env:OS -ne "Windows_NT") { throw "Ten instalator jest przygotowany dla Windows." }

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$server = Join-Path $repoRoot "services\phoneme_aligner\mis_phoneme_aligner.py"
if (-not (Test-Path $server)) { throw "Brak alignera: $server" }

Step "Miniforge / Conda"
$conda = Find-Conda
if (-not $conda) {
  if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    throw "Brak Conda/Miniforge i brak winget. Zainstaluj Miniforge3, potem uruchom skrypt ponownie."
  }
  $answer = Read-Host "Brak Miniforge. Zainstalowac teraz przez winget? [T/N]"
  if ($answer -notmatch "^[TtYy]") {
    throw "Instalacja przerwana. Miś Phoneme Aligner wymaga Miniforge/Conda."
  }
  winget install -e --id CondaForge.Miniforge3 --accept-package-agreements --accept-source-agreements
  $conda = Find-Conda
  if (-not $conda) {
    throw "Miniforge zostal zainstalowany, ale conda.exe nie jest jeszcze widoczny. Otworz nowy PowerShell i uruchom skrypt ponownie."
  }
}
Write-Host "Conda: $conda" -ForegroundColor Green

Step "Srodowisko $EnvName"
$envJson = & $conda env list --json | ConvertFrom-Json
$exists = $false
foreach ($path in $envJson.envs) {
  if ((Split-Path $path -Leaf) -eq $EnvName) { $exists = $true; break }
}
if (-not $exists) {
  & $conda create -y -n $EnvName -c conda-forge python=3.11 montreal-forced-aligner ffmpeg fastapi uvicorn pydantic
  if ($LASTEXITCODE -ne 0) { throw "Nie udalo sie utworzyc srodowiska $EnvName." }
} else {
  Write-Host "Srodowisko istnieje." -ForegroundColor Green
}

Step "Modele PL / EN / DE"
$models = @(
  @("dictionary", "polish_mfa"),
  @("acoustic", "polish_mfa"),
  @("g2p", "polish_mfa"),
  @("dictionary", "english_us_mfa"),
  @("acoustic", "english_mfa"),
  @("g2p", "english_us_mfa"),
  @("dictionary", "german_mfa"),
  @("acoustic", "german_mfa"),
  @("g2p", "german_mfa")
)
foreach ($model in $models) {
  Write-Host ("MFA model " + $model[0] + " " + $model[1])
  & $conda run -n $EnvName mfa model download $model[0] $model[1]
  if ($LASTEXITCODE -ne 0) {
    Write-Warning ("Model " + $model[1] + " nie zostal potwierdzony. Sprawdz komunikat MFA.")
  }
}

Step "Konfiguracja tokenu"
$token = [Environment]::GetEnvironmentVariable("MIS_ALIGNER_TOKEN", "User")
if ([string]::IsNullOrWhiteSpace($token)) {
  $token = New-RandomToken
  [Environment]::SetEnvironmentVariable("MIS_ALIGNER_TOKEN", $token, "User")
}
$url = "http://127.0.0.1:$Port"
[Environment]::SetEnvironmentVariable("MIS_ALIGNER_URL", $url, "User")
$env:MIS_ALIGNER_URL = $url
$env:MIS_ALIGNER_TOKEN = $token
$env:MIS_ALIGNER_PORT = "$Port"

Write-Host "MIS_ALIGNER_URL=$url" -ForegroundColor Green
Write-Host "MIS_ALIGNER_TOKEN ustawiony bez wyswietlania sekretu." -ForegroundColor Green

if ($NoStart) {
  Write-Host "Konfiguracja gotowa. Uruchom bez -NoStart, aby wystartowac aligner."
  exit 0
}

Step "Start Miś Phoneme Aligner"
$headers = @{ Authorization = "Bearer $token" }
$alreadyRunning = $false
try {
  $health = Invoke-RestMethod -Uri "$url/health" -Headers $headers -TimeoutSec 3
  if ($health.ok) { $alreadyRunning = $true }
} catch {}

if (-not $alreadyRunning) {
  $command = "& `"$conda`" run -n `"$EnvName`" --no-capture-output python `"$server`""
  Start-Process powershell -ArgumentList @("-NoProfile", "-Command", $command) -WorkingDirectory $repoRoot | Out-Null

  $ok = $false
  for ($i = 0; $i -lt 120; $i++) {
    Start-Sleep -Milliseconds 500
    try {
      $health = Invoke-RestMethod -Uri "$url/health" -Headers $headers -TimeoutSec 3
      if ($health.ok) { $ok = $true; break }
    } catch {}
  }
  if (-not $ok) {
    throw "Aligner nie odpowiedzial na $url/health. Sprawdz okno procesu mis-aligner."
  }
}

Step "Aligner gotowy"
Write-Host "Miś Phoneme Aligner -> $url" -ForegroundColor Green
Write-Host "Jezyki: PL / EN / DE" -ForegroundColor Green
