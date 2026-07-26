@echo off
cd /d "%~dp0..\.."
call pnpm --filter @jojo/data-workbench build
if errorlevel 1 exit /b %errorlevel%
cd /d "%~dp0"
python app.py
pause
