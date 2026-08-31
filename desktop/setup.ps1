$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$python = Join-Path $project '.venv\Scripts\python.exe'

if (-not (Test-Path $python)) {
    py -3.11 -m venv (Join-Path $project '.venv')
    & $python -m pip install --upgrade pip
    & $python -m pip install -r (Join-Path $project 'requirements.txt')
    & $python -m playwright install chromium
}

& (Join-Path $PSScriptRoot 'run_backfill.ps1')

$action = New-ScheduledTaskAction -Execute 'PowerShell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $PSScriptRoot 'run_daily.ps1')`""
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday -At 5:20PM
Register-ScheduledTask -TaskName 'ChinaMoneyFxDaily' -Action $action -Trigger $trigger -Description 'Update ChinaMoney FX desktop data' -Force | Out-Null

Write-Host 'Setup completed. A weekday 17:20 update task was created.'
