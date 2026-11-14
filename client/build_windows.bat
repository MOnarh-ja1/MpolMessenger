@echo off
cd /d "%~dp0"
set GOOS=windows
set GOARCH=amd64
go build -trimpath -ldflags "-H windowsgui -s -w" -o ..\MpolMessenger.exe .
if errorlevel 1 ( echo Build error & pause & exit /b 1 )
echo EXE ready: ..\MpolMessenger.exe
pause
