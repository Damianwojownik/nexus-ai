param()
$ErrorActionPreference = 'Stop'
& node (Join-Path $PSScriptRoot 'claude-stack.mjs') route
exit $LASTEXITCODE
