param(
  [switch]$InstallMissing
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Step([string]$m) { Write-Host ""; Write-Host ("=== " + $m + " ===") -ForegroundColor Cyan }
function Have([string]$cmd) { return [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }

Step "Nexus AI provider stack"
$order = "copilot,codex,claude-cli,openai,claude"
[Environment]::SetEnvironmentVariable("NEXUS_AI_PROVIDER_ORDER", $order, "User")
$env:NEXUS_AI_PROVIDER_ORDER = $order
Write-Host "Kolejnosc: $order" -ForegroundColor Green

if ($InstallMissing) {
  if (-not (Have "npm")) {
    Write-Warning "Brak npm. Pominieto automatyczna instalacje Codex/Claude Code."
  } else {
    if (-not (Have "codex")) {
      Step "Instalacja OpenAI Codex CLI"
      npm install -g @openai/codex
    }
    if (-not (Have "claude")) {
      Step "Instalacja Claude Code CLI"
      npm install -g @anthropic-ai/claude-code
    }
  }
}

Step "Wykrywanie providerow"
$providers = @(
  @{Name="GitHub Copilot CLI"; Command="copilot"; Args=@("--version")},
  @{Name="OpenAI Codex CLI"; Command="codex"; Args=@("--version")},
  @{Name="Claude Code CLI"; Command="claude"; Args=@("--version")}
)
foreach ($p in $providers) {
  if (Have $p.Command) {
    try {
      $v = & $p.Command @($p.Args) 2>&1 | Select-Object -First 1
      Write-Host ("CONNECTED  " + $p.Name + "  " + $v) -ForegroundColor Green
    } catch {
      Write-Host ("FOUND      " + $p.Name + " (sprawdz logowanie)") -ForegroundColor Yellow
    }
  } else {
    Write-Host ("MISSING    " + $p.Name) -ForegroundColor Yellow
  }
}

Step "Opcjonalne API"
if ($env:OPENAI_API_KEY -or [Environment]::GetEnvironmentVariable("OPENAI_API_KEY","User")) {
  Write-Host "OPENAI_API_KEY: skonfigurowany" -ForegroundColor Green
} else {
  Write-Host "OPENAI_API_KEY: brak — Codex CLI nadal moze dzialac przez logowanie ChatGPT." -ForegroundColor DarkYellow
}
if ($env:ANTHROPIC_API_KEY -or [Environment]::GetEnvironmentVariable("ANTHROPIC_API_KEY","User")) {
  Write-Host "ANTHROPIC_API_KEY: skonfigurowany" -ForegroundColor Green
} else {
  Write-Host "ANTHROPIC_API_KEY: brak — Claude Code CLI nadal moze dzialac przez swoje logowanie." -ForegroundColor DarkYellow
}

Step "Test lokalnego Ollama"
$ollamaUrl = $env:OLLAMA_BASE_URL
if (-not $ollamaUrl) { $ollamaUrl = [Environment]::GetEnvironmentVariable("OLLAMA_BASE_URL","User") }
if (-not $ollamaUrl) { $ollamaUrl = "http://127.0.0.1:11434" }
$ollamaUrl = $ollamaUrl.TrimEnd("/")
try {
  $tags = Invoke-RestMethod -Uri "$ollamaUrl/api/tags" -TimeoutSec 8
  $names = @($tags.models | ForEach-Object { $_.name })
  if ($names.Count -gt 0) {
    $preferred = @("llama3.2:3b","qwen2.5:1.5b","llama3.1:8b") | Where-Object { $names -contains $_ } | Select-Object -First 1
    if (-not $preferred) { $preferred = $names[0] }
    [Environment]::SetEnvironmentVariable("OLLAMA_MODEL", $preferred, "User")
    $env:OLLAMA_MODEL = $preferred
    Write-Host ("CONNECTED  Ollama  " + $preferred) -ForegroundColor Green
  } else {
    Write-Host "NO_MODEL   Ollama odpowiada, ale nie ma lokalnego modelu." -ForegroundColor Yellow
  }
} catch {
  Write-Host ("OFFLINE    Ollama  " + $_.Exception.Message) -ForegroundColor Yellow
}

Step "Test Agent Hub + internet"
try {
  $health = Invoke-RestMethod -Uri "http://127.0.0.1:8788/api/ai/health" -TimeoutSec 8
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
    $weather = Invoke-RestMethod -Uri "http://127.0.0.1:8788/api/weather?q=pogoda%20w%20Kolonii" -TimeoutSec 20
    Write-Host ("INTERNET   Open-Meteo: OK - " + $weather.location.name + " " + $weather.current.temperatureC + " C") -ForegroundColor Green
  } catch {
    Write-Host ("INTERNET   Weather ERROR: " + $_.Exception.Message) -ForegroundColor Yellow
  }
} catch {
  Write-Warning "Agent Hub nie odpowiada. Uruchom 'npm run hub' albo scripts/start-nexus-windows.ps1."
}

Write-Host ""
Write-Host "Gotowe. AUTO: Copilot -> Codex -> Claude Code -> OpenAI API -> Claude API; gdy chmura/kredyty odpadna, frontend przechodzi na darmowy lokalny Ollama." -ForegroundColor Green
Write-Host "Pamiec Nexusa jest niezalezna od providera, wiec Copilot i lokalny model dostaja ten sam kontekst pamieci." -ForegroundColor Green
Write-Host "Jesli Codex albo Claude nie sa zalogowane, uruchom raz odpowiednio 'codex' i 'claude' w terminalu i zakoncz logowanie." -ForegroundColor Yellow
