$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$speech = Join-Path $env:LOCALAPPDATA 'NexusAI\speech'
$environment = Join-Path $speech 'venv'
$python = Join-Path $environment 'Scripts\python.exe'
$voices = Join-Path $speech 'voices'
New-Item -ItemType Directory -Path $voices -Force | Out-Null
if (-not (Test-Path -LiteralPath $python)) {
  python -m venv $environment
  if ($LASTEXITCODE -ne 0) { throw 'Cannot create isolated speech environment.' }
}
& $python -m pip install -r (Join-Path $root 'speech\requirements.txt')
if ($LASTEXITCODE -ne 0) { throw 'Cannot install CPU speech runtime.' }
& $python -m piper.download_voices pl_PL-darkman-medium --data-dir $voices
if ($LASTEXITCODE -ne 0) { throw 'Cannot download Polish voice.' }
Invoke-WebRequest -UseBasicParsing -Uri 'https://huggingface.co/rhasspy/piper-voices/resolve/main/pl/pl_PL/darkman/medium/MODEL_CARD' -OutFile (Join-Path $voices 'pl_PL-darkman-medium.MODEL_CARD')
Write-Host 'Polish Piper Darkman voice installed. CPU only, no paid service.'
