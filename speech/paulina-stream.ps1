param([string]$BuildId = ([Guid]::NewGuid().ToString('N')))
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$encoding = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $encoding
[Console]::OutputEncoding = $encoding
if ($BuildId -notmatch '^[a-f0-9]{32}$') { throw 'Invalid Paulina build ID.' }
$build = Join-Path $PSScriptRoot ('.paulina-build-' + $BuildId)
$oldTemp = $env:TEMP
$oldTmp = $env:TMP
try {
  # Windows PowerShell's compiler scratch stays in this project and is removed before serving requests.
  [IO.Directory]::CreateDirectory($build) | Out-Null
  $env:TEMP = $build
  $env:TMP = $build
  try {
    Add-Type -AssemblyName System.Speech
    Add-Type -AssemblyName System.Web.Extensions
    $references = @('System.dll', 'System.Core.dll',
      [System.Speech.Synthesis.SpeechSynthesizer].Assembly.Location,
      [System.Web.Script.Serialization.JavaScriptSerializer].Assembly.Location)
    Add-Type -TypeDefinition ([IO.File]::ReadAllText((Join-Path $PSScriptRoot 'paulina-stream.cs'))) `
      -ReferencedAssemblies $references | Out-Null
  } finally {
    $env:TEMP = $oldTemp
    $env:TMP = $oldTmp
    Remove-Item -LiteralPath $build -Recurse -Force -ErrorAction SilentlyContinue
  }
  [PaulinaStreamWorker]::Run()
} catch {
  # Never expose synthesis input or compiler diagnostics on the wire.
  [Console]::Out.WriteLine('{"type":"ready","available":false,"voice":"Microsoft Paulina Desktop","language":"pl-PL","pcm":false,"encoding":"PCM16LE","sampleRate":16000,"channels":1,"bitsPerSample":16,"cost":0,"device":"cpu","reason":"Paulina System.Speech worker could not initialize."}')
  exit 1
}
