param()
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $env:LOCALAPPDATA) { throw 'This credential setup requires Windows LOCALAPPDATA and user DPAPI.' }
$directory = Join-Path $env:LOCALAPPDATA 'NexusAI'
$path = Join-Path $directory 'gemini-key.dpapi'
Write-Host 'Enter a NEW Gemini API key, not a key previously shared in chat.'
Write-Host 'The key stays encrypted for this Windows user outside the repository.'
$key = Read-Host 'New Gemini API key' -AsSecureString
try {
  if ($key.Length -lt 20) { throw 'The API key is too short; nothing was saved.' }
  $encrypted = ConvertFrom-SecureString -SecureString $key
  [IO.Directory]::CreateDirectory($directory) | Out-Null
  [IO.File]::WriteAllText($path, $encrypted, [Text.Encoding]::ASCII)
  Write-Host 'PASS: encrypted credential saved. No API request or billing operation performed.'
} finally {
  $key.Dispose()
}
