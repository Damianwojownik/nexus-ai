@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0connect-ai-stack-windows.ps1" -InstallMissing
echo.
echo Provider repair finished. If Copilot asks for authentication, run: copilot login
pause
endlocal
