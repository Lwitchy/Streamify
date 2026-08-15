@echo off
REM ---------------------------------------------------------------
REM  Streamify - headless server launcher
REM
REM  Starts Streamify as a plain web server (no desktop window).
REM  Use this when you want to reach it from phones/other machines.
REM
REM  For the Windows desktop app instead, run:  npm run desktop
REM
REM  Override the port:   set PORT=8080 && start_server.bat
REM ---------------------------------------------------------------

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo Node.js was not found. Install Node.js 22.12 or newer.
    pause
    exit /b 1
)
node -e "const [major,minor]=process.versions.node.split('.').map(Number);process.exit(major>22||(major===22&&minor>=12)?0:1)"
if errorlevel 1 (
    echo Streamify requires Node.js 22.12 or newer. Current version:
    node --version
    pause
    exit /b 1
)

if not exist "node_modules" (
    echo Dependencies not installed. Running npm install...
    call npm install
    if errorlevel 1 (
        echo.
        echo npm install failed. Make sure Node.js 22.12+ is installed.
        pause
        exit /b 1
    )
)

node Server/server.js
if errorlevel 1 pause
