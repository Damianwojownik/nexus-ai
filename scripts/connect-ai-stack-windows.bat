@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0connect-ai-stack-windows.ps1" %*
endlocal
