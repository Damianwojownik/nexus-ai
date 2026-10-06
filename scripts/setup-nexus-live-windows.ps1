param(
  [switch]$InstallSystemPrereqs,
  [switch]$InstallLocalWorker,
  [switch]$SkipNpm
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$Root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $Root
$ConfigPath = Join-Path $Root ".nexus-live.local.ps1"

function Require-Command([string]$Name, [string]$WingetId) {
  $command = Get-Command $Name -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  if (-not $InstallSystemPrereqs) {
    throw "$Name is missing. Re-run with -InstallSystemPrereqs or install it manually."
  }
  if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) {
    throw "$Name is missing and winget is not available."
  }
  Write-Host "Installing $Name ($WingetId)..."
  & winget.exe install --id $WingetId --exact --accept-source-agreements --accept-package-agreements --silent
  if ($LASTEXITCODE -ne 0) { throw "winget failed to install $Name." }
  $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
  $command = Get-Command $Name -ErrorAction SilentlyContinue
  if (-not $command) { throw "$Name was installed but is not visible on PATH yet. Open a new PowerShell and run setup again." }
  return $command.Source
}

function New-Secret {
  $bytes = New-Object byte[] 32
  [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
  return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+','-').Replace('/','_')
}

Write-Host "Nexus Live local setup: $Root"
Require-Command "git.exe" "Git.Git" | Out-Null
Require-Command "node.exe" "OpenJS.NodeJS.LTS" | Out-Null
Require-Command "npm.cmd" "OpenJS.NodeJS.LTS" | Out-Null
Require-Command "ffmpeg.exe" "Gyan.FFmpeg" | Out-Null

$branchName = (& git branch --show-current).Trim()
if ($branchName -ne "chatgpt/nexus-live-complete") {
  Write-Warning "Current branch is '$branchName'. Recommended branch is chatgpt/nexus-live-complete."
  Write-Warning "Setup will not switch branches automatically because that could overwrite local work."
}

if (-not $SkipNpm) {
  if (Test-Path (Join-Path $Root "package-lock.json")) {
    Write-Host "Installing Node dependencies with npm ci..."
    & npm.cmd ci
  } else {
    Write-Host "Installing Node dependencies with npm install..."
    & npm.cmd install
  }
  if ($LASTEXITCODE -ne 0) { throw "Node dependency installation failed." }
}

# Python 3.11 is used only by the local WebRTC gateway.
$py = Get-Command py.exe -ErrorAction SilentlyContinue
if (-not $py) {
  if ($InstallSystemPrereqs) {
    Require-Command "python.exe" "Python.Python.3.11" | Out-Null
  } else {
    throw "Python launcher (py.exe) is missing. Install Python 3.11 or re-run with -InstallSystemPrereqs."
  }
}

$GatewayDir = Join-Path $Root "services\avatar_live"
$GatewayPython = Join-Path $GatewayDir ".venv\Scripts\python.exe"
if (-not (Test-Path $GatewayPython)) {
  if (Get-Command py.exe -ErrorAction SilentlyContinue) {
    & py.exe -3.11 -m venv (Join-Path $GatewayDir ".venv")
  } else {
    & python.exe -m venv (Join-Path $GatewayDir ".venv")
  }
  if ($LASTEXITCODE -ne 0) { throw "Could not create the live gateway Python environment." }
}
& $GatewayPython -m pip install --upgrade pip
if ($LASTEXITCODE -ne 0) { throw "Gateway pip bootstrap failed." }
& $GatewayPython -m pip install -r (Join-Path $GatewayDir "requirements.txt")
if ($LASTEXITCODE -ne 0) { throw "Gateway dependency installation failed." }

$gatewaySecret = New-Secret
$workerSecret = ""
$workerUrl = ""

if ($InstallLocalWorker) {
  Write-Warning "Local MuseTalk installation is large and requires a CUDA-capable NVIDIA GPU."
  Write-Warning "A GTX 970 / 4 GB class GPU is not expected to satisfy the production live renderer minimum."
  if (-not (Get-Command py.exe -ErrorAction SilentlyContinue)) {
    throw "Python launcher is required for the MuseTalk installer."
  }
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root "services\avatar_live_worker\install_windows.ps1")
  if ($LASTEXITCODE -ne 0) { throw "Local MuseTalk worker installation failed." }
  $workerSecret = New-Secret
  $workerUrl = "http://127.0.0.1:9874"
}

if (Test-Path $ConfigPath) {
  $backup = "$ConfigPath.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
  Copy-Item -LiteralPath $ConfigPath -Destination $backup
  Write-Host "Backed up existing live config to $backup"
}

$config = @(
  '# Local Nexus Live configuration. Never commit this file.',
  ('$env:NEXUS_LIVE_AVATAR_SERVER_TOKEN = "' + $gatewaySecret + '"'),
  '$env:NEXUS_LIVE_AVATAR_SERVER_URL = "http://127.0.0.1:9873"',
  '$env:NEXUS_LIVE_AVATAR_CONTROL_URL_BASE = "ws://127.0.0.1:9873"'
)
if ($workerUrl) {
  $config += ('$env:NEXUS_LIVE_AVATAR_WORKER_URL = "' + $workerUrl + '"')
  $config += ('$env:NEXUS_LIVE_AVATAR_WORKER_TOKEN = "' + $workerSecret + '"')
} else {
  $config += '# Set these two values after provisioning the remote GPU worker:'
  $config += '# $env:NEXUS_LIVE_AVATAR_WORKER_URL = "https://<gpu-worker-host>"'
  $config += '# $env:NEXUS_LIVE_AVATAR_WORKER_TOKEN = "<server-only-worker-secret>"'
}
Set-Content -LiteralPath $ConfigPath -Value ($config -join [Environment]::NewLine) -Encoding UTF8

Write-Host ""
Write-Host "Local Nexus/Paulina/WebRTC gateway setup is complete."
Write-Host "Config written to: $ConfigPath"
if (-not $workerUrl) {
  Write-Warning "The neural GPU worker is not configured yet. Add its HTTPS URL/token to .nexus-live.local.ps1."
}
Write-Host "Then run: powershell -ExecutionPolicy Bypass -File scripts\start-nexus-live-hybrid.ps1"
