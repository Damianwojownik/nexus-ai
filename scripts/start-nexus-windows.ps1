param([switch]$NoBrowser, [switch]$Repair)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root
$env:NEXUS_FREE_MODE = 'true'
$env:OLLAMA_NO_CLOUD = '1'

function Test-Http([string]$Url) {
  try { return (Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200 }
  catch [System.Net.WebException] { return $false }
}

function Start-NexusService([int]$Port, [string]$Url, [string[]]$NodeArguments) {
  if (Test-Http $Url) { Write-Host "Service responding: $Url"; return }
  $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  if ($listener) { throw "Port $Port is occupied but $Url is not responding. No existing process was stopped." }
  $node = (Get-Command node.exe -ErrorAction Stop).Source
  $process = Start-Process -FilePath $node -ArgumentList $NodeArguments -WorkingDirectory $root -PassThru
  for ($attempt = 0; $attempt -lt 40; $attempt++) {
    if (Test-Http $Url) { Write-Host "Started service PID $($process.Id): $Url"; return }
    $process.Refresh()
    if ($process.HasExited) { throw "Service exited with code $($process.ExitCode): $Url" }
    Start-Sleep -Milliseconds 500
  }
  throw "Service PID $($process.Id) did not become responsive: $Url"
}

Write-Host "Nexus FREE / LOCAL FIRST startup: $root"
Write-Host 'No purchases, subscriptions, provider credentials or automatic model downloads.'
if ($Repair) { Write-Warning 'Automatic process repair is disabled. Stop only your own stale process before restarting.' }
if (-not (Test-Path -LiteralPath (Join-Path $root 'node_modules\vite\bin\vite.js'))) {
  throw 'Project dependencies are missing. Restore dependencies with npm install before startup.'
}
$ollama = Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe'
if ((Test-Path -LiteralPath $ollama) -and -not (Test-Http 'http://127.0.0.1:11434/')) {
  $env:CUDA_VISIBLE_DEVICES = '-1'
  $env:GGML_VK_VISIBLE_DEVICES = '-1'
  $env:OLLAMA_VULKAN = 'false'
  $env:OLLAMA_HOST = '127.0.0.1:11434'
  $process = Start-Process -FilePath $ollama -ArgumentList 'serve' -PassThru
  for ($attempt = 0; $attempt -lt 40; $attempt++) {
    if (Test-Http 'http://127.0.0.1:11434/') { break }
    $process.Refresh()
    if ($process.HasExited) { throw "Ollama exited with code $($process.ExitCode)." }
    Start-Sleep -Milliseconds 500
  }
  if (-not (Test-Http 'http://127.0.0.1:11434/')) { throw 'CPU-only Ollama did not become responsive.' }
}
Start-NexusService 8788 'http://127.0.0.1:8788/api/health' @('--experimental-strip-types', 'helpers\agentHubRuntime.ts')
Start-NexusService 5173 'http://127.0.0.1:5173/' @('node_modules\vite\bin\vite.js', '--host', '127.0.0.1', '--port', '5173', '--strictPort')
$health = Invoke-RestMethod 'http://127.0.0.1:8788/api/ai/health' -TimeoutSec 30
if (-not $health.freeOnly) { throw 'Existing Hub is not running FREE MODE. Stop your old Hub explicitly and restart.' }
$health | ConvertTo-Json -Depth 6
if (-not $NoBrowser) { Start-Process 'http://127.0.0.1:5173/' }
Write-Host 'Nexus is responding in FREE MODE. Optional offline tools do not block startup.'
