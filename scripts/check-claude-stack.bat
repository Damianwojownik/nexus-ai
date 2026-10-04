@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0check-claude-stack.ps1" %*
exit /b %errorlevel%
