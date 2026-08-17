@echo off
cd /d "%~dp0..\..\.."
call pnpm build:admin
if errorlevel 1 exit /b %errorlevel%
cd /d "%~dp0"
python app.py
pause
