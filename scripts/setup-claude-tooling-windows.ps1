param(
  [switch]$SkipHeadroom,
  [switch]$SkipOmniRoute
)

$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $RepoRoot

function Require-Command([string]$Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Brak wymaganego polecenia: $Name"
  }
}

function Run-Soft([scriptblock]$Command, [string]$Label) {
  try {
    & $Command
  } catch {
    Write-Warning "$Label: $($_.Exception.Message)"
  }
}

Write-Host "== Nexus Claude Tooling ==" -ForegroundColor Cyan
Require-Command node
Require-Command npm

$nodeMajor = [int]((node --version).TrimStart("v").Split(".")[0])
if ($nodeMajor -lt 18) {
  throw "Claude Code wymaga Node.js 18+. Wykryto: $(node --version)"
}

Write-Host "[1/6] Claude Code" -ForegroundColor Green
npm install -g @anthropic-ai/claude-code@latest
claude --version

if (-not $SkipOmniRoute) {
  Write-Host "[2/6] OmniRoute" -ForegroundColor Green
  npm install -g omniroute@latest
  Run-Soft { omniroute doctor } "OmniRoute doctor"
} else {
  Write-Host "[2/6] OmniRoute pominięty" -ForegroundColor DarkYellow
}

Write-Host "[3/6] claude-setup" -ForegroundColor Green
Run-Soft { claude plugin marketplace add nickmaglowsch/claude-setup } "Marketplace claude-setup"
Run-Soft { claude plugin install claude-setup@claude-setup --scope local } "Plugin claude-setup"

if (-not $SkipHeadroom) {
  Write-Host "[4/6] Headroom" -ForegroundColor Green
  if (Get-Command uv -ErrorAction SilentlyContinue) {
    Run-Soft { uv tool install --python 3.13 "headroom-ai[all]" } "Headroom via uv"
  } elseif (Get-Command py -ErrorAction SilentlyContinue) {
    Run-Soft { py -3 -m pip install --user --upgrade "headroom-ai[all]" } "Headroom via pip"
  } elseif (Get-Command python -ErrorAction SilentlyContinue) {
    Run-Soft { python -m pip install --user --upgrade "headroom-ai[all]" } "Headroom via pip"
  } else {
    Write-Warning "Brak Python/uv. Headroom nie został zainstalowany."
  }

  if (Get-Command headroom -ErrorAction SilentlyContinue) {
    Run-Soft { headroom init claude } "Headroom init Claude"
    Run-Soft { headroom doctor } "Headroom doctor"
  } else {
    Write-Warning "Polecenie headroom nie jest na PATH. Uruchom ponownie terminal lub dodaj katalog Scripts użytkownika do PATH."
  }
} else {
  Write-Host "[4/6] Headroom pominięty" -ForegroundColor DarkYellow
}

Write-Host "[5/6] Task Observer" -ForegroundColor Green
Run-Soft {
  npx -y skills add rebelytics/one-skill-to-rule-them-all --skill task-observer --agent claude-code
} "Task Observer"

if (-not $SkipOmniRoute) {
  Write-Host "[6/6] OmniRoute MCP dla Claude" -ForegroundColor Green
  Run-Soft {
    claude mcp add --transport http --scope local omniroute http://127.0.0.1:20128/api/mcp/stream
  } "OmniRoute MCP"
} else {
  Write-Host "[6/6] OmniRoute MCP pominięty" -ForegroundColor DarkYellow
}

Write-Host ""
Write-Host "Weryfikacja:" -ForegroundColor Cyan
Run-Soft { claude doctor } "Claude doctor"
Run-Soft { claude mcp list } "Claude MCP list"

Write-Host ""
Write-Host "Gotowe. Dwa kroki wymagają Twojej interakcji:" -ForegroundColor Cyan
Write-Host "  1. Uruchom: claude   i zaloguj się do Claude."
if (-not $SkipOmniRoute) {
  Write-Host "  2. Uruchom: omniroute setup   skonfiguruj providery, potem: omniroute"
}
Write-Host "Po zmianach otwórz nową sesję Claude, aby hooki Headroom/Task Observer zostały aktywowane."
