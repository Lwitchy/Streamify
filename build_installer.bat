@echo off
setlocal enabledelayedexpansion
title Streamify - Build Installer

REM ===================================================================
REM  Streamify - Build the Windows app
REM
REM  Produces a distributable .exe in the dist-electron folder.
REM
REM  Usage:
REM      build_installer.bat            installer  (default)
REM      build_installer.bat portable   single portable .exe
REM      build_installer.bat dir        unpacked folder, fastest
REM ===================================================================

cd /d "%~dp0"

set BUILD_MODE=%~1
if "%BUILD_MODE%"=="" set BUILD_MODE=installer

echo.
echo   Streamify - Build
echo   =================
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

REM --- Install dependencies if needed -------------------------------
if not exist "node_modules" (
    echo   Installing dependencies first. This takes a few minutes.
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

REM --- Read the version out of package.json -------------------------
for /f "usebackq delims=" %%v in (`node -p "require('./package.json').version"`) do set APP_VERSION=%%v

REM --- Pick the build target ----------------------------------------
if /i "%BUILD_MODE%"=="portable" (
    set NPM_SCRIPT=build:portable
    set MODE_LABEL=Portable executable
) else if /i "%BUILD_MODE%"=="dir" (
    set NPM_SCRIPT=build:dir
    set MODE_LABEL=Unpacked folder ^(no installer^)
) else if /i "%BUILD_MODE%"=="installer" (
    set NPM_SCRIPT=build
    set MODE_LABEL=Installer
) else (
    echo   [X] Unknown option: %BUILD_MODE%
    echo.
    echo   Valid options are:  installer ^| portable ^| dir
    echo.
    pause
    exit /b 1
)

echo   Version : %APP_VERSION%
echo   Target  : !MODE_LABEL!
echo.
echo   Building. This usually takes 1-3 minutes...
echo.

call npm run !NPM_SCRIPT!

if errorlevel 1 (
    echo.
    echo   [X] Build failed. See the errors above.
    echo.
    echo   Common fixes:
    echo     - Close Streamify if it is currently running
    echo     - Run:  npm run rebuild
    echo.
    pause
    exit /b 1
)

echo.
echo   ============================================
echo    Build complete
echo   ============================================
echo.

if /i "%BUILD_MODE%"=="dir" (
    echo   Unpacked app:
    echo     dist-electron\win-unpacked\Streamify.exe
) else if /i "%BUILD_MODE%"=="portable" (
    echo   Portable app:
    echo     dist-electron\Streamify-Portable-%APP_VERSION%.exe
) else (
    echo   Installer ready to share:
    echo     dist-electron\Streamify-Setup-%APP_VERSION%.exe
)

echo.
echo   Note: the build is unsigned, so Windows SmartScreen will warn
echo   on first run. Click "More info" then "Run anyway".
echo.

REM --- Offer to open the output folder ------------------------------
choice /c YN /n /m "  Open the output folder? [Y/N] "
if errorlevel 2 goto :done
if errorlevel 1 start "" explorer "%~dp0dist-electron"

:done
echo.
endlocal
