@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows.ps1" -Action install
if errorlevel 1 (
  echo Installation failed. See the error above.
  pause
  exit /b 1
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows.ps1" -Action start
if errorlevel 1 (
  echo Installation succeeded but startup failed. See data\logs.
  pause
  exit /b 1
)
