@echo off
setlocal
title Streamify - Desktop App

REM ===================================================================
REM  Streamify - Run the desktop app
REM
REM  Opens the Streamify window and starts the server inside it.
REM  Phones on your network can connect to it at the same time.
REM
REM  Optional: set a custom port before running, e.g.
REM      set PORT=8080 && run_desktop.bat
REM ===================================================================

cd /d "%~dp0"

echo.
echo   Streamify - Desktop App
echo   =======================
echo.

REM --- Check Node.js is installed -----------------------------------
where node >nul 2>nul
if errorlevel 1 (
    echo   [X] Node.js was not found.
    echo.
    echo   Install Node.js 22.12 or newer from https://nodejs.org
    echo   then run this file again.
    echo.
    pause
    exit /b 1
)
node -e "const [major,minor]=process.versions.node.split('.').map(Number);process.exit(major>22||(major===22&&minor>=12)?0:1)"
if errorlevel 1 (
    echo   [X] Streamify requires Node.js 22.12 or newer.
    echo       Current version:
    node --version
    pause
    exit /b 1
)

REM --- Install dependencies on first run ----------------------------
if not exist "node_modules" (
    echo   First run detected - installing dependencies.
    echo   This takes a few minutes and only happens once.
    echo.
    call npm install
    if errorlevel 1 (
        echo.
        echo   [X] npm install failed. See the errors above.
        echo.
        pause
        exit /b 1
    )
    echo.
)

REM --- Make sure Electron's binary actually downloaded ---------------
REM  Newer npm versions block package install scripts by default, which
REM  silently skips Electron's binary download. Recover automatically.
if not exist "node_modules\electron\dist\electron.exe" (
    echo   Electron binary missing - downloading it now...
    echo.
    node node_modules\electron\install.js
    if errorlevel 1 (
        echo.
        echo   [X] Could not download Electron.
        echo       Check your internet connection and try again.
        echo.
        pause
        exit /b 1
    )
    echo.
)

echo   Starting Streamify...
echo   ^(Close this window to shut the server down.^)
echo.

call npm run desktop

if errorlevel 1 (
    echo.
    echo   [X] Streamify exited with an error.
    echo.
    echo   Check the log for details:
    echo       %%APPDATA%%\Streamify\logs\main.log
    echo.
    pause
    exit /b 1
)

endlocal
