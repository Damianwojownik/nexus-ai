param(
  [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Step([string]$m) { Write-Host ""; Write-Host ("=== " + $m + " ===") -ForegroundColor Cyan }
function Have([string]$cmd) { return [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }
function PortOpen([int]$port) {
  try {
    $c = New-Object System.Net.Sockets.TcpClient
    $task = $c.ConnectAsync("127.0.0.1", $port)
    if (-not $task.Wait(500)) { $c.Dispose(); return $false }
    $ok = $c.Connected
    $c.Dispose()
    return $ok
  } catch { return $false }
}

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Step "Nexus startup"
Write-Host ("Repo: " + $root)

if (-not (Have "npm")) {
  throw "Brak npm/Node.js. Zainstaluj Node.js LTS."
}

Step "Ollama fallback"
if (Have "ollama") {
  if (-not (PortOpen 11434)) {
    Write-Host "Uruchamiam Ollama serve..." -ForegroundColor Yellow
    Start-Process -FilePath "ollama" -ArgumentList "serve" -WindowStyle Minimized | Out-Null
    Start-Sleep -Seconds 2
  }
  if (PortOpen 11434) {
    try {
      $tags = Invoke-RestMethod -Uri "http://127.0.0.1:11434/api/tags" -TimeoutSec 8
      $names = @($tags.models | ForEach-Object { $_.name })
      if ($names.Count -gt 0) {
        $preferred = @("llama3.2:3b","qwen2.5:1.5b","llama3.1:8b") | Where-Object { $names -contains $_ } | Select-Object -First 1
        if (-not $preferred) { $preferred = $names[0] }
        [Environment]::SetEnvironmentVariable("OLLAMA_MODEL", $preferred, "User")
        $env:OLLAMA_MODEL = $preferred
        Write-Host ("Ollama READY: " + $preferred) -ForegroundColor Green
      } else {
        Write-Host "Ollama działa, ale nie ma modelu. Przykład: ollama pull llama3.2:3b" -ForegroundColor Yellow
      }
    } catch {
      Write-Host ("Ollama test: " + $_.Exception.Message) -ForegroundColor Yellow
    }
  }
} else {
  Write-Host "Ollama nie jest zainstalowana — fallback lokalny będzie niedostępny." -ForegroundColor Yellow
}

Step "Agent Hub"
if (-not (PortOpen 8788)) {
  Start-Process powershell -ArgumentList @("-NoExit","-ExecutionPolicy","Bypass","-Command","Set-Location '$root'; npm run hub") | Out-Null
  for ($i=0; $i -lt 20 -and -not (PortOpen 8788); $i++) { Start-Sleep -Milliseconds 500 }
}
if (PortOpen 8788) { Write-Host "Agent Hub READY: http://127.0.0.1:8788" -ForegroundColor Green }
else { Write-Host "Agent Hub nie wystartował." -ForegroundColor Red }

Step "Frontend"
if (-not (PortOpen 5173)) {
  Start-Process powershell -ArgumentList @("-NoExit","-ExecutionPolicy","Bypass","-Command","Set-Location '$root'; npm run dev") | Out-Null
  for ($i=0; $i -lt 20 -and -not (PortOpen 5173); $i++) { Start-Sleep -Milliseconds 500 }
}
if (PortOpen 5173) { Write-Host "Nexus READY: http://127.0.0.1:5173" -ForegroundColor Green }
else { Write-Host "Frontend nie wystartował." -ForegroundColor Red }

Step "Kontrola chmury, internetu i fallbacku"
& (Join-Path $PSScriptRoot "connect-ai-stack-windows.ps1")

if (-not $NoBrowser -and (PortOpen 5173)) {
  Start-Process "http://127.0.0.1:5173/"
}
