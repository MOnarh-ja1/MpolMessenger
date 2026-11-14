@echo off
cd /d "%~dp0"
echo Launching local MPOL server (Python 3.11+ required)...
start "MPOL SERVER" "%~dp0server\start_server.bat"
echo Launching MPOL Messenger interface...
start "" "%~dp0MpolMessenger.exe"
echo If server is still installing Python packages, wait for its READY message and refresh the messenger window.
