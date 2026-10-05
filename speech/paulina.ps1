param(
  [Parameter(Mandatory=$true)][string]$TextFile,
  [Parameter(Mandatory=$true)][string]$AudioFile
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$voice = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $installed = $voice.GetInstalledVoices() | Where-Object {
    $_.Enabled -and $_.VoiceInfo.Culture.Name -eq 'pl-PL' -and
    $_.VoiceInfo.Gender -eq [System.Speech.Synthesis.VoiceGender]::Female -and
    $_.VoiceInfo.Name -match '\bPaulina\b'
  } | Select-Object -First 1
  if (-not $installed) { throw 'Local Polish female Microsoft Paulina voice is not installed for SAPI.' }
  $text = [IO.File]::ReadAllText($TextFile, [Text.Encoding]::UTF8).Trim()
  if ($text.Length -lt 1 -or $text.Length -gt 6000) { throw 'Speech requires 1-6000 characters.' }
  $voice.SelectVoice($installed.VoiceInfo.Name)
  $format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(
    16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
    [System.Speech.AudioFormat.AudioChannel]::Mono
  )
  $voice.SetOutputToWaveFile($AudioFile, $format)
  $voice.Speak($text)
} finally {
  $voice.Dispose()
}
