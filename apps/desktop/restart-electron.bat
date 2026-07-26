@echo off
chcp 65001 >nul
echo 🔴 正在停止所有 Electron 进程...

:: 使用 PowerShell 强制终止所有 Electron 进程
powershell -Command "Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue"

:: 等待一下确保进程结束
timeout /t 1 /nobreak >nul

:: 再次使用 taskkill 清理残留
taskkill /F /IM electron.exe 2>nul

echo 🟢 正在启动 Electron...
echo.

:: 启动 Electron
node dev-runner.mjs electron

pause
