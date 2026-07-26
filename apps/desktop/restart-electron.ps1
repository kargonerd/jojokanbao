# Electron restart script
# Usage: .\restart-electron.ps1

Write-Host 'Stopping all Electron processes...' -ForegroundColor Red

$electronProcesses = Get-Process -Name 'electron' -ErrorAction SilentlyContinue
if ($electronProcesses) {
    Write-Host "Found $($electronProcesses.Count) Electron processes. Force stopping..." -ForegroundColor Yellow
    $electronProcesses | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
}

$remaining = Get-Process -Name 'electron' -ErrorAction SilentlyContinue
if ($remaining) {
    Write-Host 'Processes remain. Using taskkill...' -ForegroundColor Yellow
    taskkill /F /IM electron.exe 2>$null
    Start-Sleep -Milliseconds 300
}

$finalCheck = Get-Process -Name 'electron' -ErrorAction SilentlyContinue
if ($finalCheck) {
    Write-Host 'Warning: some Electron processes could not be stopped.' -ForegroundColor Red
    $finalCheck | Select-Object Id, ProcessName, MainWindowTitle
} else {
    Write-Host 'All Electron processes are cleared.' -ForegroundColor Green
}

Write-Host ''
Write-Host 'Starting Electron...' -ForegroundColor Green
Set-Location $PSScriptRoot
node dev-runner.mjs electron
