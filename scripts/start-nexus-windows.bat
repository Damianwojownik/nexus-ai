@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-nexus-windows.ps1"
exit /b %errorlevel%