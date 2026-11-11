@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows.ps1" -Action start
if errorlevel 1 (
  echo Startup failed. See data\logs and the error above.
  pause
  exit /b 1
)
