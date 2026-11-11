@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows.ps1" -Action install
if errorlevel 1 (
  echo Setup could not start. See data\logs and the error above.
  pause
  exit /b 1
)
