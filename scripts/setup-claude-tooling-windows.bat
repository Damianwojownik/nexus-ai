@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-claude-tooling-windows.ps1" %*
exit /b %errorlevel%
