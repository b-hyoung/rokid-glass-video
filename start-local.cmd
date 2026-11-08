@echo off
cd /d "%~dp0"
python tools\start_local.py
if errorlevel 1 pause
