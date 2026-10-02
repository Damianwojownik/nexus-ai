param(
  [switch]$InstallMissing
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Step([string]$m) { Write-Host ""; Write-Host ("=== " + $m + " ===") -ForegroundColor Cyan }
function Have([string]$cmd) { return [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }
function UserEnv([string]$name) {
  $v = [Environment]::GetEnvironmentVariable($name, "User")
  if ($v) { return $v.Trim() }
  return ""
}
function PortOpen([int]$port) {
  try {
    $c = New-Object System.Net.Sockets.TcpClient
    $task = $c.ConnectAsync("127.0.0.1", $port)
    if (-not $task.Wait(600)) { $c.Dispose(); return $false }
    $ok = $c.Connected
    $c.Dispose()
    return $ok
  } catch { return $false }
}

Step "Nexus AI provider stack"
$order = "copilot,codex,gemini,claude-cli,openai,claude"
[Environment]::SetEnvironmentVariable("NEXUS_AI_PROVIDER_ORDER", $order, "User")
$env:NEXUS_AI_PROVIDER_ORDER = $order
Write-Host "Kolejnosc chmury: $order" -ForegroundColor Green

if ($InstallMissing) {
  Step "Naprawa brakujacych providerow"

  if (-not (Have "copilot")) {
    if (Have "winget") {
      Write-Host "Instaluje GitHub Copilot CLI..." -ForegroundColor Yellow
      winget install --id GitHub.Copilot -e --accept-source-agreements --accept-package-agreements
    } elseif (Have "npm") {
      Write-Host "Instaluje GitHub Copilot CLI przez npm..." -ForegroundColor Yellow
      npm install -g @github/copilot
    } else {
      Write-Warning "Brak winget i npm — nie moge automatycznie zainstalowac Copilot CLI."
    }
  }

  if (Have "npm") {
    if (-not (Have "codex")) {
      Step "Instalacja OpenAI Codex CLI"
      npm install -g @openai/codex
    }
    if (-not (Have "claude")) {
      Step "Instalacja Claude Code CLI"
      npm install -g @anthropic-ai/claude-code
    }
  } else {
    Write-Warning "Brak npm. Pominieto automatyczna instalacje Codex/Claude Code."
  }

  if (-not (Have "ollama")) {
    Step "Instalacja darmowego lokalnego Ollama"
    if (Have "winget") {
      winget install --id Ollama.Ollama -e --accept-source-agreements --accept-package-agreements
    } else {
      Write-Host "Brak winget — uruchamiam oficjalny instalator Ollama PowerShell." -ForegroundColor Yellow
      Invoke-RestMethod "https://ollama.com/install.ps1" | Invoke-Expression
    }
    Start-Sleep -Seconds 2
  }
}

Step "Wykrywanie providerow chmurowych"
$providers = @(
  @{Name="GitHub Copilot CLI"; Command="copilot"; Args=@("--version")},
  @{Name="OpenAI Codex CLI"; Command="codex"; Args=@("--version")},
  @{Name="Claude Code CLI"; Command="claude"; Args=@("--version")}
)
foreach ($p in $providers) {
  if (Have $p.Command) {
    try {
      $v = & $p.Command @($p.Args) 2>&1 | Select-Object -First 1
      Write-Host ("FOUND      " + $p.Name + "  " + $v) -ForegroundColor Green
    } catch {
      Write-Host ("FOUND      " + $p.Name + " (sprawdz logowanie)") -ForegroundColor Yellow
    }
  } else {
    Write-Host ("MISSING    " + $p.Name) -ForegroundColor Yellow
  }
}

if (Have "gh") {
  try {
    gh auth status 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { Write-Host "GITHUB     gh auth: OK" -ForegroundColor Green }
    else { Write-Host "GITHUB     gh auth: wymaga logowania" -ForegroundColor Yellow }
  } catch {
    Write-Host "GITHUB     gh auth: wymaga logowania" -ForegroundColor Yellow
  }
}

Step "Opcjonalne API"
$gemini = $env:GOOGLE_GEMINI_API_KEY
if (-not $gemini) { $gemini = $env:GEMINI_API_KEY }
if (-not $gemini) { $gemini = $env:NEXUS_GEMINI_API_KEY }
if (-not $gemini) { $gemini = UserEnv "GOOGLE_GEMINI_API_KEY" }
if (-not $gemini) { $gemini = UserEnv "GEMINI_API_KEY" }
if (-not $gemini) { $gemini = UserEnv "NEXUS_GEMINI_API_KEY" }
if ($gemini) {
  Write-Host "Gemini API: skonfigurowany" -ForegroundColor Green
} else {
  Write-Host "Gemini API: brak — nie blokuje pracy, bo Copilot/Codex/Ollama maja pierwszenstwo." -ForegroundColor DarkYellow
}
if ($env:OPENAI_API_KEY -or (UserEnv "OPENAI_API_KEY")) {
  Write-Host "OPENAI_API_KEY: skonfigurowany" -ForegroundColor Green
} else {
  Write-Host "OPENAI_API_KEY: brak — Codex CLI moze dzialac przez logowanie ChatGPT." -ForegroundColor DarkYellow
}
if ($env:ANTHROPIC_API_KEY -or (UserEnv "ANTHROPIC_API_KEY")) {
  Write-Host "ANTHROPIC_API_KEY: skonfigurowany" -ForegroundColor Green
} else {
  Write-Host "ANTHROPIC_API_KEY: brak — Claude Code CLI moze dzialac przez swoje logowanie." -ForegroundColor DarkYellow
}

Step "Darmowy lokalny fallback Ollama"
$ollamaUrl = $env:OLLAMA_BASE_URL
if (-not $ollamaUrl) { $ollamaUrl = UserEnv "OLLAMA_BASE_URL" }
if (-not $ollamaUrl) { $ollamaUrl = "http://127.0.0.1:11434" }
$ollamaUrl = $ollamaUrl.TrimEnd("/")
[Environment]::SetEnvironmentVariable("OLLAMA_BASE_URL", $ollamaUrl, "User")
$env:OLLAMA_BASE_URL = $ollamaUrl

if ((Have "ollama") -and -not (PortOpen 11434)) {
  Write-Host "Uruchamiam ollama serve..." -ForegroundColor Yellow
  Start-Process -FilePath "ollama" -ArgumentList "serve" -WindowStyle Minimized | Out-Null
  for ($i=0; $i -lt 20 -and -not (PortOpen 11434); $i++) { Start-Sleep -Milliseconds 500 }
}

try {
  $tags = Invoke-RestMethod -Uri "$ollamaUrl/api/tags" -TimeoutSec 8
  $names = @($tags.models | ForEach-Object { $_.name })
  if ($names.Count -eq 0 -and $InstallMissing -and (Have "ollama")) {
    Write-Host "Brak modelu. Pobieram lekki model qwen2.5:1.5b..." -ForegroundColor Yellow
    & ollama pull qwen2.5:1.5b
    $tags = Invoke-RestMethod -Uri "$ollamaUrl/api/tags" -TimeoutSec 8
    $names = @($tags.models | ForEach-Object { $_.name })
  }
  if ($names.Count -gt 0) {
    $preferred = @("llama3.2:3b","qwen2.5:1.5b","llama3.1:8b") | Where-Object { $names -contains $_ } | Select-Object -First 1
    if (-not $preferred) { $preferred = $names[0] }
    [Environment]::SetEnvironmentVariable("OLLAMA_MODEL", $preferred, "User")
    $env:OLLAMA_MODEL = $preferred
    Write-Host ("CONNECTED  Ollama  " + $preferred + "  " + $ollamaUrl) -ForegroundColor Green
  } else {
    Write-Host "NO_MODEL   Ollama odpowiada, ale nie ma lokalnego modelu." -ForegroundColor Yellow
  }
} catch {
  Write-Host ("OFFLINE    Ollama  " + $_.Exception.Message) -ForegroundColor Red
}

Step "Test Agent Hub + internet"
try {
  $health = Invoke-RestMethod -Uri "http://127.0.0.1:8788/api/ai/health" -TimeoutSec 12
  $health | ConvertTo-Json -Depth 6

  try {
    $search = Invoke-RestMethod -Uri "http://127.0.0.1:8788/api/search?q=OpenAI" -TimeoutSec 20
    $count = @($search.results).Count
    if ($count -gt 0) { Write-Host ("INTERNET   DuckDuckGo search: OK (" + $count + " wynikow)") -ForegroundColor Green }
    else { Write-Host "INTERNET   DuckDuckGo search: brak wynikow" -ForegroundColor Yellow }
  } catch {
    Write-Host ("INTERNET   Search ERROR: " + $_.Exception.Message) -ForegroundColor Yellow
  }

  try {
    $weather = Invoke-RestMethod -Uri "http://127.0.0.1:8788/api/weather?q=Kolonia" -TimeoutSec 20
    Write-Host ("INTERNET   Open-Meteo: OK - " + $weather.location.name + " " + $weather.current.temperatureC + " C") -ForegroundColor Green
  } catch {
    Write-Host ("INTERNET   Weather ERROR: " + $_.Exception.Message) -ForegroundColor Yellow
  }

  try {
    $connectorResult = Invoke-RestMethod -Uri "http://127.0.0.1:8788/api/connectors" -TimeoutSec 20
    foreach ($connector in @($connectorResult.connectors)) {
      $suffix = if ($connector.toolCount -ne $null) { " (" + $connector.toolCount + " tools)" } else { "" }
      $color = if ($connector.status -eq "CONNECTED") { "Green" } elseif ($connector.status -eq "NOT_CONFIGURED") { "DarkYellow" } else { "Yellow" }
      Write-Host ("CONNECTOR  " + $connector.name + ": " + $connector.status + $suffix) -ForegroundColor $color
    }
  } catch {
    Write-Host ("CONNECTOR  diagnostics ERROR: " + $_.Exception.Message) -ForegroundColor Yellow
  }
} catch {
  Write-Warning "Agent Hub nie odpowiada. Uruchom 'npm run hub' albo scripts/start-nexus-windows.ps1."
}

Write-Host ""
Write-Host "AUTO: Copilot -> Codex -> Gemini -> Claude Code -> OpenAI API -> Claude API -> darmowy lokalny Ollama." -ForegroundColor Green
Write-Host "Pamiec i narzedzia Nexusa pozostaja po stronie Nexusa, wiec zmiana providera nie kasuje kontekstu." -ForegroundColor Green
Write-Host "Jesli Copilot nie jest zalogowany, uruchom: copilot login" -ForegroundColor Yellow
Write-Host "Naprawa wszystkiego jednym poleceniem: scripts\repair-ai-stack-windows.bat" -ForegroundColor Cyan
