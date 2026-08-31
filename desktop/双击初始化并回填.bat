@echo off
setlocal
cd /d "%~dp0.."
echo.
echo 正在初始化中国货币网外汇桌面数据仓库……
echo 首次运行会安装依赖并从 2023 年开始回填，请保持本窗口开启。
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0初始化并回填.ps1"
echo.
if errorlevel 1 (
  echo 初始化未完成。请截取以上红色报错发给我，我会按报错修复。
) else (
  echo 完成。数据已写入桌面\中国货币网外汇数据\
)
pause
