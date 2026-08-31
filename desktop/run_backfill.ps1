param([string]$StartDate = '2023-01-01')
$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$desktop = [Environment]::GetFolderPath('Desktop')
$dataFolder = Join-Path $desktop '中国货币网外汇数据'
New-Item -ItemType Directory -Force -Path $dataFolder | Out-Null

$env:CHINAMONEY_DATA_DIR = $dataFolder
$env:CHINAMONEY_CREATE_XLSX = '1'
$env:PYTHONPATH = Join-Path $project 'src'
$python = Join-Path $project '.venv\Scripts\python.exe'
if (-not (Test-Path $python)) { throw '请先运行 desktop\初始化并回填.ps1。' }
& $python -m chinamoney_fx.backfill --start $StartDate

Write-Host "历史回填完成：$dataFolder\中国货币网外汇历史.xlsx"
