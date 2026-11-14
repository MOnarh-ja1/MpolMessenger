@echo off
cd /d "%~dp0"
where py >nul 2>nul && (set "PYCMD=py -3") || (set "PYCMD=python")
if not exist .venv ( %PYCMD% -m venv .venv )
call .venv\Scripts\activate.bat
python -m pip install -r requirements.txt
if errorlevel 1 (echo Error installing dependencies & pause & exit /b 1)
echo MPOL API listening at http://127.0.0.1:8000
python -m uvicorn app:app --host 127.0.0.1 --port 8000
pause
