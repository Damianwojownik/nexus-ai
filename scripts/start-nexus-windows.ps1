param(
  [switch]$NoBrowser,
  [switch]$Repair
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Step([string]$m) { Write-Host ""; Write-Host ("=== " + $m + " ===") -ForegroundColor Cyan }
function Have([string]$cmd) { return [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }
function PortOpen([int]$port) {
  try {
    $c = New-Object System.Net.Sockets.TcpClient
    $task = $c.ConnectAsync("127.0.0.1", $port)
    if (-not $task.Wait(700)) { $c.Dispose(); return $false }
    $ok = $c.Connected
    $c.Dispose()
    return $ok
  } catch { return $false }
}
function WaitHttp([string]$url,[int]$seconds=20) {
  $deadline=(Get-Date).AddSeconds($seconds)
  do {
    try { Invoke-RestMethod -Uri $url -TimeoutSec 2 | Out-Null; return $true } catch {}
    Start-Sleep -Milliseconds 500
  } while((Get-Date) -lt $deadline)
  return $false
}
function StopNexusNodeOnPort([int]$port) {
  try {
    $rows=Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    foreach($row in @($rows)) {
      $pidValue=$row.OwningProcess
      if(-not $pidValue){ continue }
      $proc=Get-CimInstance Win32_Process -Filter "ProcessId=$pidValue" -ErrorAction SilentlyContinue
      $cmd=[string]$proc.CommandLine
      if($proc.Name -match '^node(\.exe)?$' -and ($cmd -match 'nexus-ai|agentHubRuntime|vite')) {
        Write-Host ("Restartuje stary proces Nexusa na porcie " + $port + " (PID " + $pidValue + ")") -ForegroundColor Yellow
        Stop-Process -Id $pidValue -Force -ErrorAction SilentlyContinue
      }
    }
  } catch {}
}

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Step "Nexus startup"
Write-Host ("Repo: " + $root)

if (-not (Have "npm")) {
  throw "Brak npm/Node.js. Zainstaluj Node.js LTS."
}

$nodeModules=Join-Path $root "node_modules"
$joseModule=Join-Path $nodeModules "jose"
if ((-not (Test-Path $nodeModules)) -or (-not (Test-Path $joseModule))) {
  Step "Instalacja/aktualizacja zaleznosci projektu"
  npm install
}

Step "Provider setup"
& (Join-Path $PSScriptRoot "connect-ai-stack-windows.ps1") -InstallMissing

$ollamaUrl=$env:OLLAMA_BASE_URL
if(-not $ollamaUrl){$ollamaUrl=[Environment]::GetEnvironmentVariable("OLLAMA_BASE_URL","User")}
if(-not $ollamaUrl){$ollamaUrl="http://127.0.0.1:11434"}
$model=$env:OLLAMA_MODEL
if(-not $model){$model=[Environment]::GetEnvironmentVariable("OLLAMA_MODEL","User")}
if(-not $model){$model="qwen2.5:1.5b"}

# Browser config contains only local URLs/model names, never API keys.
$envFile=Join-Path $root ".env.local"
@(
  "VITE_NEXUS_AGENT_HUB_URL=http://127.0.0.1:8788",
  "VITE_OLLAMA_BASE_URL=$ollamaUrl",
  "VITE_OLLAMA_MODEL=$model"
) | Set-Content -Path $envFile -Encoding UTF8

if($Repair){
  StopNexusNodeOnPort 8788
  StopNexusNodeOnPort 5173
  Start-Sleep -Milliseconds 500
}

Step "Ollama fallback"
if (Have "ollama") {
  if (-not (PortOpen 11434)) {
    Write-Host "Uruchamiam Ollama serve..." -ForegroundColor Yellow
    $env:OLLAMA_ORIGINS="http://127.0.0.1:5173,http://localhost:5173"
    Start-Process -FilePath "ollama" -ArgumentList "serve" -WindowStyle Minimized | Out-Null
    for ($i=0; $i -lt 20 -and -not (PortOpen 11434); $i++) { Start-Sleep -Milliseconds 500 }
  }
  if (PortOpen 11434) {
    try {
      $tags = Invoke-RestMethod -Uri "http://127.0.0.1:11434/api/tags" -TimeoutSec 8
      $names = @($tags.models | ForEach-Object { $_.name })
      if ($names.Count -eq 0) {
        Write-Host "Brak modelu — pobieram qwen2.5:1.5b..." -ForegroundColor Yellow
        & ollama pull qwen2.5:1.5b
        $tags = Invoke-RestMethod -Uri "http://127.0.0.1:11434/api/tags" -TimeoutSec 8
        $names = @($tags.models | ForEach-Object { $_.name })
      }
      if ($names.Count -gt 0) {
        $preferred = @("llama3.2:3b","qwen2.5:1.5b","llama3.1:8b") | Where-Object { $names -contains $_ } | Select-Object -First 1
        if (-not $preferred) { $preferred = $names[0] }
        [Environment]::SetEnvironmentVariable("OLLAMA_MODEL", $preferred, "User")
        $env:OLLAMA_MODEL = $preferred
        Write-Host ("Ollama READY: " + $preferred) -ForegroundColor Green
      }
    } catch {
      Write-Host ("Ollama test: " + $_.Exception.Message) -ForegroundColor Red
    }
  }
} else {
  Write-Host "Ollama nadal nie jest zainstalowana." -ForegroundColor Red
}

Step "Agent Hub"
if (-not (PortOpen 8788)) {
  Start-Process powershell -ArgumentList @("-NoExit","-ExecutionPolicy","Bypass","-Command","Set-Location '$root'; npm run hub") | Out-Null
}
if (WaitHttp "http://127.0.0.1:8788/api/health" 25) {
  Write-Host "Agent Hub READY: http://127.0.0.1:8788" -ForegroundColor Green
  try {
    $plan=Invoke-RestMethod -Uri "http://127.0.0.1:8788/api/chatgpt/status" -TimeoutSec 8
    if($plan.connected -and $plan.planUsageEnabled){
      Write-Host ("ChatGPT plan READY: " + $plan.model) -ForegroundColor Green
    } else {
      Write-Host "ChatGPT plan: jeszcze niepolaczony. W Nexusie wybierz Continue with ChatGPT." -ForegroundColor Yellow
    }
  } catch {
    Write-Host ("ChatGPT plan status: " + $_.Exception.Message) -ForegroundColor Yellow
  }
} else {
  Write-Host "Agent Hub ERROR — backend nie wystartowal." -ForegroundColor Red
}

Step "Frontend"
if (-not (PortOpen 5173)) {
  Start-Process powershell -ArgumentList @("-NoExit","-ExecutionPolicy","Bypass","-Command","Set-Location '$root'; npm run dev") | Out-Null
}
if (PortOpen 5173) { Write-Host "Nexus READY: http://127.0.0.1:5173" -ForegroundColor Green }
else { Write-Host "Frontend nie wystartowal." -ForegroundColor Red }

Step "Kontrola AI + internetu"
try {
  $ai=Invoke-RestMethod -Uri "http://127.0.0.1:8788/api/ai/health" -TimeoutSec 15
  $ai | ConvertTo-Json -Depth 8
} catch {
  Write-Host ("AI HUB ERROR: " + $_.Exception.Message) -ForegroundColor Red
}
try {
  $oll=Invoke-RestMethod -Uri "http://127.0.0.1:11434/api/tags" -TimeoutSec 8
  Write-Host ("OLLAMA MODELS: " + (@($oll.models).Count)) -ForegroundColor Green
} catch {
  Write-Host ("OLLAMA OFFLINE: " + $_.Exception.Message) -ForegroundColor Red
}
try {
  $weather=Invoke-RestMethod -Uri "http://127.0.0.1:8788/api/weather?q=Kolonia" -TimeoutSec 20
  Write-Host ("INTERNET/WEATHER OK: " + $weather.location.name) -ForegroundColor Green
} catch {
  Write-Host ("INTERNET/WEATHER ERROR: " + $_.Exception.Message) -ForegroundColor Yellow
}

if (-not $NoBrowser -and (PortOpen 5173)) {
  Start-Process "http://127.0.0.1:5173/"
}
