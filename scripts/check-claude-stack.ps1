param()
$ErrorActionPreference = 'Stop'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error 'FAIL Node: executable not found on PATH.'
  exit 1
}
& node (Join-Path $PSScriptRoot 'claude-stack.mjs') check
exit $LASTEXITCODE
