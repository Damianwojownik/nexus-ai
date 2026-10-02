@echo off
setlocal
echo === Nexus Backend + AI repair ===
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-nexus-windows.ps1" -Repair
if errorlevel 1 (
  echo.
  echo Naprawa nie zakonczyla sie poprawnie. Zostaw to okno otwarte i skopiuj komunikat bledu.
  pause
  exit /b 1
)
echo.
echo Gotowe. Nexus powinien byc pod http://127.0.0.1:5173/
pause
endlocal
