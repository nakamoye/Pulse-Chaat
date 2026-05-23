@echo off
setlocal EnableExtensions
cd /d "%~dp0"

set "NODE_EXE="

rem 1) Node in PATH
where node >nul 2>&1
if %ERRORLEVEL%==0 (
  for /f "delims=" %%N in ('where node 2^>nul') do (
    set "NODE_EXE=%%N"
    goto :found
  )
)

rem 2) Standard Node.js install
for %%P in (
  "%ProgramFiles%\nodejs\node.exe"
  "%ProgramFiles(x86)%\nodejs\node.exe"
  "%LOCALAPPDATA%\Programs\node\node.exe"
) do (
  if exist %%P (
    set "NODE_EXE=%%~fP"
    goto :found
  )
)

rem 3) Node bundled with Cursor
for %%P in (
  "%LOCALAPPDATA%\Programs\cursor\resources\app\resources\helpers\node.exe"
  "%LOCALAPPDATA%\Programs\Cursor\resources\app\resources\helpers\node.exe"
  "C:\Program Files\Cursor\resources\app\resources\helpers\node.exe"
  "D:\cursor\resources\app\resources\helpers\node.exe"
  "C:\cursor\resources\app\resources\helpers\node.exe"
) do (
  if exist %%P (
    set "NODE_EXE=%%~fP"
    goto :found
  )
)

echo.
echo  Node.js not found.
echo  Install: https://nodejs.org/  (LTS)
echo.
pause
exit /b 1

:found
rem If port already in use — server is probably already running
netstat -ano | findstr ":3847" | findstr "LISTENING" >nul 2>&1
if %ERRORLEVEL%==0 (
  echo.
  echo  Pulse Chat already running on http://localhost:3847
  echo  Opening browser...
  echo.
  start "" "http://localhost:3847"
  pause
  exit /b 0
)

echo Starting Pulse Chat on http://localhost:3847
echo Using: %NODE_EXE%
echo.
start "" "http://localhost:3847"
"%NODE_EXE%" server.js
if errorlevel 1 (
  echo.
  echo  Server exited with an error.
  echo  If port is busy, run stop.bat then start.bat again.
  pause
  exit /b 1
)
pause
