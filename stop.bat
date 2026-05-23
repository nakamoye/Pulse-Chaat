@echo off
setlocal EnableExtensions
echo Stopping Pulse Chat on port 3847...

set "FOUND=0"
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":3847" ^| findstr "LISTENING"') do (
  set "FOUND=1"
  echo Killing process PID %%P
  taskkill /PID %%P /F >nul 2>&1
)

if "%FOUND%"=="0" (
  echo No server found on port 3847.
) else (
  echo Done. You can start again with start.bat
)
echo.
pause
