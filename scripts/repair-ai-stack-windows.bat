@echo off
setlocal
echo === Nexus AI repair ===
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0connect-ai-stack-windows.ps1" -InstallMissing
if errorlevel 1 (
  echo.
  echo Repair step returned an error. Check the messages above.
  pause
  exit /b 1
)
echo.
echo Starting Nexus after repair...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-nexus-windows.ps1"
echo.
echo If Copilot asks for authentication, run once: copilot login
pause
endlocal
