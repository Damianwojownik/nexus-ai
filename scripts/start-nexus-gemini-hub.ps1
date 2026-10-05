param([switch]$FreeTierConfirmed)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $env:LOCALAPPDATA) { throw 'This launcher requires Windows user DPAPI.' }
if (-not $FreeTierConfirmed) {
  throw 'Verify the key project is Free Tier with NO billing account in AI Studio before using -FreeTierConfirmed. This is your attestation, not automatic billing verification.'
}
$path = Join-Path $env:LOCALAPPDATA 'NexusAI\gemini-key.dpapi'
if (-not (Test-Path -LiteralPath $path)) { throw 'Run scripts\set-nexus-gemini-key.ps1 to store a new key first.' }
if (Get-NetTCPConnection -LocalPort 8788 -State Listen -ErrorAction SilentlyContinue) {
  throw 'Hub port 8788 is occupied. Stop only your own existing Hub before using this launcher. No process was stopped.'
}
$node = (Get-Command node.exe -ErrorAction Stop).Source
$names = @('GEMINI_API_KEY', 'GEMINI_MODEL', 'NEXUS_GEMINI_FREE_CONFIRMED', 'NEXUS_PRIMARY_PROVIDER', 'NEXUS_FREE_MODE', 'OLLAMA_NO_CLOUD')
$previous = @{}
foreach ($name in $names) { $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
$key = ConvertTo-SecureString -String ([IO.File]::ReadAllText($path, [Text.Encoding]::ASCII))
$pointer = [IntPtr]::Zero
try {
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($key)
  $env:GEMINI_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  $env:GEMINI_MODEL = 'gemini-2.5-flash'
  $env:NEXUS_GEMINI_FREE_CONFIRMED = 'true'
  $env:NEXUS_PRIMARY_PROVIDER = 'google-gemini'
  $env:NEXUS_FREE_MODE = 'true'
  $env:OLLAMA_NO_CLOUD = '1'
  Write-Host 'Starting FREE Hub: confirmed Gemini Free Tier -> Ollama -> llama.cpp. No paid fallback.'
  Push-Location (Split-Path -Parent $PSScriptRoot)
  try {
    & $node --experimental-strip-types 'helpers\agentHubRuntime.ts'
    if ($LASTEXITCODE -ne 0) { throw "Hub exited with code $LASTEXITCODE." }
  } finally { Pop-Location }
} finally {
  if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
  $key.Dispose()
  foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process') }
}
