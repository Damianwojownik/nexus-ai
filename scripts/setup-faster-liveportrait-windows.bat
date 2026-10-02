@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-faster-liveportrait-windows.ps1" %*
endlocal
