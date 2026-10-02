param(
  [string]$InstallDir = (Join-Path $PSScriptRoot "..\\vendor\\FasterLivePortrait"),
  [switch]$SkipModels,
  [switch]$CpuOnly
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Step([string]$m) { Write-Host ""; Write-Host ("=== " + $m + " ===") -ForegroundColor Cyan }
function Have([string]$cmd) { return [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }

Step "Nexus / FasterLivePortrait - kontrola systemu"
if ($env:OS -ne "Windows_NT") { throw "Ten instalator jest przygotowany dla Windows." }

if (-not (Have "git")) { throw "Brak Git. Zainstaluj Git for Windows i uruchom skrypt ponownie." }
git --version

$pyMode = ""
if (Have "py") {
  try {
    $v = & py -3.11 -c "import sys; print('.'.join(map(str,sys.version_info[:3])))" 2>$null
    if ($LASTEXITCODE -eq 0) { $pyMode = "launcher"; Write-Host "Python: $v" }
  } catch {}
}
if (-not $pyMode -and (Have "python")) {
  $v = & python -c "import sys; print('.'.join(map(str,sys.version_info[:3])))"
  if ($v -like "3.11.*") { $pyMode = "python"; Write-Host "Python: $v" }
}
if (-not $pyMode) { throw "Nie znaleziono Pythona 3.11.x. Masz mieć 3.11.9." }

if (-not (Have "ffmpeg")) {
  Step "Instalacja FFmpeg"
  if (Have "winget") {
    winget install --id Gyan.FFmpeg -e --accept-package-agreements --accept-source-agreements
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
  } elseif (Have "choco") {
    choco install ffmpeg -y
  } elseif (Have "scoop") {
    scoop install ffmpeg
  } else {
    Write-Warning "Brak winget/choco/scoop. Zainstaluj FFmpeg ręcznie i dodaj go do PATH."
  }
} else {
  ffmpeg -version | Select-Object -First 1
}

Step "Sprawdzenie GPU NVIDIA"
if (Have "nvidia-smi") {
  nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader
} else {
  Write-Warning "nvidia-smi nie jest dostępne. Sterownik NVIDIA może wymagać instalacji/aktualizacji."
}

$InstallDir = [IO.Path]::GetFullPath($InstallDir)
$parent = Split-Path $InstallDir -Parent
New-Item -ItemType Directory -Force -Path $parent | Out-Null

Step "Klonowanie / aktualizacja FasterLivePortrait"
if (Test-Path (Join-Path $InstallDir ".git")) {
  git -C $InstallDir fetch origin
  git -C $InstallDir checkout master
  git -C $InstallDir pull --ff-only origin master
} else {
  git clone https://github.com/warmshao/FasterLivePortrait.git $InstallDir
}
Set-Location $InstallDir

Step "Tworzenie venv"
if (-not (Test-Path ".venv\\Scripts\\python.exe")) {
  if ($pyMode -eq "launcher") { & py -3.11 -m venv .venv } else { & python -m venv .venv }
}
$python = Join-Path $InstallDir ".venv\\Scripts\\python.exe"
& $python -m pip install --upgrade pip setuptools wheel

Step "Instalacja zaleznosci Windows"
& $python -m pip install -r requirements_win.txt

if ($CpuOnly) {
  Step "ONNX Runtime CPU"
  & $python -m pip install --upgrade onnxruntime
} else {
  Step "ONNX Runtime GPU - bez wymuszania nowego CUDA/TensorRT"
  try {
    & $python -m pip install --upgrade "onnxruntime-gpu<1.19"
  } catch {
    Write-Warning "onnxruntime-gpu nie zainstalował się. Instaluję CPU fallback."
    & $python -m pip install --upgrade onnxruntime
  }
}

if (-not $SkipModels) {
  Step "Pobieranie modeli FasterLivePortrait"
  & $python -m pip install --upgrade "huggingface_hub[cli]"
  $hf = Join-Path $InstallDir ".venv\\Scripts\\huggingface-cli.exe"
  if (Test-Path $hf) {
    & $hf download warmshao/FasterLivePortrait --local-dir .\\checkpoints
  } else {
    Write-Warning "Nie znaleziono huggingface-cli; modele trzeba pobrać ręcznie."
  }
}

Step "Diagnostyka"
& $python -c "import sys; print('Python',sys.version)"
& $python -c "import cv2, numpy, onnx; print('OpenCV',cv2.__version__,'NumPy',numpy.__version__,'ONNX',onnx.__version__)"
try {
  & $python -c "import onnxruntime as ort; print('ONNX Runtime',ort.__version__); print('Providers:',ort.get_available_providers())"
} catch {
  Write-Warning "ONNX Runtime test failed: $($_.Exception.Message)"
}

Write-Host ""
Write-Host "GOTOWE: $InstallDir" -ForegroundColor Green
Write-Host "Start WebUI (ONNX):" -ForegroundColor Yellow
Write-Host "  cd $InstallDir"
Write-Host "  .\\.venv\\Scripts\\python.exe webui.py --mode onnx"
Write-Host ""
Write-Host "Port: http://localhost:9870/"
Write-Host "Najpierw potwierdzamy ONNX. TensorRT dopiero po sprawdzeniu zgodnosci GTX 970."
