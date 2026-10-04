param([switch]$NoBrowser)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root

function Test-Http([string]$Url) {
  try {
    $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 3
    return $response.StatusCode -eq 200
  } catch [System.Net.WebException] {
    return $false
  }
}

function Start-NexusService([int]$Port, [string]$Url, [string[]]$NodeArguments) {
  if (Test-Http $Url) {
    Write-Host "Service responding: $Url"
    return
  }
  $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  if ($listener) { throw "Port $Port is occupied but $Url is not responding. No existing process was stopped." }
  $node = (Get-Command node.exe -ErrorAction Stop).Source
  $process = Start-Process -FilePath $node -ArgumentList $NodeArguments -WorkingDirectory $root -PassThru
  for ($attempt = 0; $attempt -lt 40; $attempt++) {
    if (Test-Http $Url) {
      Write-Host "Started service PID $($process.Id): $Url"
      return
    }
    $process.Refresh()
    if ($process.HasExited) { throw "Service exited with code $($process.ExitCode): $Url" }
    Start-Sleep -Milliseconds 500
  }
  throw "Service PID $($process.Id) did not become responsive: $Url"
}

Write-Host "Nexus cloud + CPU-only Ollama startup: $root"
Write-Host 'No model downloads, GPU inference, credential changes or automatic installations.'
if (-not (Test-Path -LiteralPath (Join-Path $root 'node_modules\vite\bin\vite.js'))) {
  throw 'Project dependencies are missing. Restore dependencies with npm install before startup.'
}

$ollama = Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe'
if ((Test-Path -LiteralPath $ollama) -and -not (Test-Http 'http://127.0.0.1:11434/')) {
  $env:CUDA_VISIBLE_DEVICES = '-1'
  $env:GGML_VK_VISIBLE_DEVICES = '-1'
  $env:OLLAMA_VULKAN = 'false'
  $env:OLLAMA_HOST = '127.0.0.1:11434'
  $ollamaProcess = Start-Process -FilePath $ollama -ArgumentList 'serve' -PassThru
  for ($attempt = 0; $attempt -lt 40; $attempt++) {
    if (Test-Http 'http://127.0.0.1:11434/') { break }
    $ollamaProcess.Refresh()
    if ($ollamaProcess.HasExited) { throw "Ollama exited with code $($ollamaProcess.ExitCode)." }
    Start-Sleep -Milliseconds 500
  }
  if (-not (Test-Http 'http://127.0.0.1:11434/')) { throw 'CPU-only Ollama did not become responsive.' }
}

Start-NexusService 8788 'http://127.0.0.1:8788/api/health' @('--experimental-strip-types', 'helpers\agentHubRuntime.ts')
Start-NexusService 5173 'http://127.0.0.1:5173/' @('node_modules\vite\bin\vite.js', '--host', '127.0.0.1', '--port', '5173', '--strictPort')

$health = Invoke-RestMethod -Uri 'http://127.0.0.1:8788/api/ai/health' -TimeoutSec 30
if ($health.cloud.status -ne 'healthy') {
  Write-Warning "Cloud chat is unavailable: $($health.cloud.status). Startup does not create provider credentials."
}
$health | ConvertTo-Json -Depth 6

if (-not $NoBrowser) {
  $edgePaths = @(
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
  )
  $edge = $edgePaths | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  if (-not $edge) { throw 'Edge was not found. Open http://127.0.0.1:5173/ in ordinary Chrome or Edge.' }
  Start-Process -FilePath $edge -ArgumentList 'http://127.0.0.1:5173/'
}
Write-Host 'Nexus UI and backend are responding. Cloud model readiness is reported separately above.'
