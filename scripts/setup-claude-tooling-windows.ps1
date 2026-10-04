param(
  [switch]$SkipHeadroom,
  [switch]$SkipOmniRoute,
  [switch]$SkipPlugins,
  [switch]$SkipTaskObserver,
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error 'Install a supported Node runtime (22.22.2+, or 24/25/26) first.'
  exit 1
}
$Arguments = @('setup')
$Flags = @{
  SkipHeadroom = '--skip-headroom'
  SkipOmniRoute = '--skip-omniroute'
  SkipPlugins = '--skip-plugins'
  SkipTaskObserver = '--skip-task-observer'
  DryRun = '--dry-run'
}
foreach ($Option in $Flags.Keys) {
  if (Get-Variable -Name $Option -ValueOnly) {
    $Arguments += $Flags[$Option]
  }
}
& node (Join-Path $PSScriptRoot 'claude-stack.mjs') @Arguments
exit $LASTEXITCODE
