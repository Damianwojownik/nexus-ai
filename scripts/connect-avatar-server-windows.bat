@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0connect-avatar-server-windows.ps1" %*
endlocal
