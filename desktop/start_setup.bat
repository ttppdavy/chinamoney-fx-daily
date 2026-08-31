@echo off
setlocal
cd /d "%~dp0.."
echo Starting ChinaMoney FX desktop data setup...
echo This first run installs dependencies and backfills history from 2023.
echo Keep this window open until it finishes.
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1"
echo.
if errorlevel 1 (
  echo Setup failed. Please send a screenshot of the error above.
) else (
  echo Done. Check the ChinaMoney FX data folder on your Desktop.
)
pause
