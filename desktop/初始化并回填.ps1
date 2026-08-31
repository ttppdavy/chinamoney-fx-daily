$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$python = Join-Path $project '.venv\Scripts\python.exe'

if (-not (Test-Path $python)) {
    py -3.11 -m venv (Join-Path $project '.venv')
    & $python -m pip install --upgrade pip
    & $python -m pip install -r (Join-Path $project 'requirements.txt')
    & $python -m playwright install chromium
}

# First seed the Desktop history.  Subsequent runs only need run_daily.ps1.
& (Join-Path $PSScriptRoot 'run_backfill.ps1')

# Daily at 17:20 Beijing, after the published implied-rate and swap curves.
$action = New-ScheduledTaskAction -Execute 'PowerShell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $PSScriptRoot 'run_daily.ps1')`""
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday -At 5:20PM
Register-ScheduledTask -TaskName '中国货币网外汇每日更新' -Action $action -Trigger $trigger -Description '更新桌面中国货币网外汇数据' -Force | Out-Null

Write-Host '已创建工作日 17:20 自动更新任务。'
