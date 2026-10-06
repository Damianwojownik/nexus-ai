param(
  [string]$Python = "py"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$WorkerDir = Join-Path $RepoRoot "services\avatar_live_worker"
$ToolsDir = Join-Path $RepoRoot ".tools"
$MuseTalkDir = Join-Path $ToolsDir "MuseTalk"
$VenvDir = Join-Path $WorkerDir ".venv"
$VenvPython = Join-Path $VenvDir "Scripts\python.exe"
$VenvPip = Join-Path $VenvDir "Scripts\pip.exe"
$MuseTalkCommit = "0a89dec45a0192b824e3cf4daf96c239440c5ed8"

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  throw "Git is required."
}
if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
  throw "FFmpeg is required and must be present on PATH."
}

New-Item -ItemType Directory -Force -Path $ToolsDir | Out-Null
if (-not (Test-Path (Join-Path $MuseTalkDir ".git"))) {
  & git clone https://github.com/TMElyralab/MuseTalk.git $MuseTalkDir
  if ($LASTEXITCODE -ne 0) { throw "MuseTalk clone failed." }
}

& git -C $MuseTalkDir fetch --depth 1 origin $MuseTalkCommit
if ($LASTEXITCODE -ne 0) { throw "MuseTalk fetch failed." }
& git -C $MuseTalkDir checkout --detach $MuseTalkCommit
if ($LASTEXITCODE -ne 0) { throw "MuseTalk checkout failed." }
$Actual = (& git -C $MuseTalkDir rev-parse HEAD).Trim()
if ($Actual -ne $MuseTalkCommit) { throw "MuseTalk pin mismatch: $Actual" }

if (-not (Test-Path $VenvPython)) {
  if ($Python -eq "py") {
    & py -3.10 -m venv $VenvDir
  } else {
    & $Python -m venv $VenvDir
  }
  if ($LASTEXITCODE -ne 0) { throw "Could not create Python 3.10 virtual environment." }
}

& $VenvPython -m pip install --upgrade pip setuptools wheel
if ($LASTEXITCODE -ne 0) { throw "pip bootstrap failed." }

& $VenvPip install torch==2.0.1 torchvision==0.15.2 torchaudio==2.0.2 --index-url https://download.pytorch.org/whl/cu118
if ($LASTEXITCODE -ne 0) { throw "PyTorch CUDA installation failed." }

& $VenvPip install -r (Join-Path $MuseTalkDir "requirements.txt")
if ($LASTEXITCODE -ne 0) { throw "MuseTalk Python dependencies failed." }

& $VenvPip install --upgrade openmim
if ($LASTEXITCODE -ne 0) { throw "openmim installation failed." }
$Mim = Join-Path $VenvDir "Scripts\mim.exe"
& $Mim install mmengine
if ($LASTEXITCODE -ne 0) { throw "mmengine installation failed." }
& $Mim install "mmcv==2.0.1"
if ($LASTEXITCODE -ne 0) { throw "mmcv installation failed." }
& $Mim install "mmdet==3.1.0"
if ($LASTEXITCODE -ne 0) { throw "mmdet installation failed." }
& $Mim install "mmpose==1.1.0"
if ($LASTEXITCODE -ne 0) { throw "mmpose installation failed." }

& $VenvPip install -r (Join-Path $WorkerDir "requirements.txt")
if ($LASTEXITCODE -ne 0) { throw "Nexus live worker dependencies failed." }
& $VenvPip install "huggingface_hub==0.30.2" gdown
if ($LASTEXITCODE -ne 0) { throw "Model downloader dependencies failed." }

& $VenvPython (Join-Path $WorkerDir "download_models.py") --musetalk-dir $MuseTalkDir
if ($LASTEXITCODE -ne 0) { throw "MuseTalk model download failed." }

$env:NEXUS_MUSETALK_DIR = $MuseTalkDir
& $VenvPython -c "import torch; print('Torch:', torch.__version__); print('CUDA available:', torch.cuda.is_available()); print('GPU:', torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'none'); print('VRAM GiB:', round(torch.cuda.get_device_properties(0).total_memory/1024**3,2) if torch.cuda.is_available() else 0)"
if ($LASTEXITCODE -ne 0) { throw "GPU verification failed." }

Write-Host ""
Write-Host "Nexus Live worker installation complete."
Write-Host "Set NEXUS_LIVE_AVATAR_WORKER_TOKEN and run services\avatar_live_worker\start_windows.ps1"
