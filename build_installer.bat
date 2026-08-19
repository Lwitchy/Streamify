@echo off
setlocal enabledelayedexpansion
title Streamify - Build Installer

REM ===================================================================
REM  Streamify - Build the app
REM
REM  Produces distributables in the dist-electron folder.
REM
REM  Usage:
REM      build_installer.bat                  ask what to build
REM
REM      build_installer.bat installer        Windows installer
REM      build_installer.bat portable         single portable .exe
REM      build_installer.bat dir              unpacked folder, fastest
REM
REM      build_installer.bat linux            AppImage + deb + tar.gz
REM      build_installer.bat linux-appimage   AppImage only
REM      build_installer.bat linux-deb        deb only
REM      build_installer.bat linux-targz      tar.gz only
REM      build_installer.bat linux-dir        unpacked Linux folder
REM
REM      build_installer.bat all              Windows installer + Linux
REM
REM  Run with no arguments - which is what double-clicking does, since
REM  Explorer cannot pass one - and the script asks which platforms to
REM  build and whether to bump the version first.
REM
REM  An optional second argument bumps the version without prompting:
REM      build_installer.bat installer patch
REM      build_installer.bat all 1.2.0
REM
REM  Version bumping runs `npm version <x> --no-git-tag-version`, which
REM  rewrites package.json and package-lock.json and stops there: no
REM  commit, no tag, no push. Git stays entirely in your hands.
REM
REM  Why bump at all: an installed copy only offers an update when the
REM  published version is higher than the one it is running, so a
REM  release build needs a new number. A test build does not.
REM
REM  Why Linux needs Docker
REM  ----------------------
REM  Windows has no dpkg/fakeroot/appimagetool, and the sqlite3 native
REM  binding in node_modules is a Windows .node file - shipping it in a
REM  Linux bundle produces an app that dies on first launch. So the
REM  Linux targets are built inside the official electron-builder
REM  container, which has the packaging tools and compiles sqlite3 for
REM  Linux. Docker Desktop must be installed and running.
REM
REM  The container gets its own node_modules (a named Docker volume), so
REM  your Windows node_modules is never overwritten. If a Linux build
REM  ever gets into a bad state, reset it with:
REM      docker volume rm streamify-linux-node-modules
REM
REM  Override the image with:  set STREAMIFY_BUILDER_IMAGE=...
REM ===================================================================

cd /d "%~dp0"

echo.
echo   Streamify - Build
echo   =================
echo.

if not defined STREAMIFY_BUILDER_IMAGE set STREAMIFY_BUILDER_IMAGE=electronuserland/builder:24

set BUILD_MODE=%~1
set VERSION_ARG=%~2

REM  A mode on the command line means "no questions": stay scriptable.
if not "%BUILD_MODE%"=="" goto :apply_version

REM ===================================================================
REM  Interactive setup
REM
REM  Order matters here. Nothing is changed on disk until every
REM  question has been answered and the Docker preflight has passed,
REM  so cancelling - or discovering the engine is down - can never
REM  leave a bumped package.json behind with no build to show for it.
REM ===================================================================

echo   What would you like to build?
echo.
echo     [1]  Windows installer                 ^(default^)
echo     [2]  Windows portable single .exe
echo     [3]  Windows unpacked folder           ^(fastest, for testing^)
echo.
echo     [4]  Linux AppImage                    ^(needs Docker^)
echo     [5]  Linux AppImage + deb + tar.gz     ^(needs Docker^)
echo     [6]  Linux unpacked folder             ^(needs Docker^)
echo.
echo     [7]  Windows installer + all Linux     ^(needs Docker^)
echo.
echo     [8]  Cancel
echo.
echo   For linux-deb or linux-targz on their own, run this file from a
echo   terminal with that name as an argument.
echo.

choice /c 12345678 /n /m "  Choose [1-8]: "
set MENU_CHOICE=!errorlevel!
echo.

if "!MENU_CHOICE!"=="8" (
    echo   Cancelled. Nothing was built and no files were changed.
    echo.
    exit /b 0
)

set NEEDS_DOCKER=0
if "!MENU_CHOICE!"=="1" set BUILD_MODE=installer
if "!MENU_CHOICE!"=="2" set BUILD_MODE=portable
if "!MENU_CHOICE!"=="3" set BUILD_MODE=dir
if "!MENU_CHOICE!"=="4" set BUILD_MODE=linux-appimage& set NEEDS_DOCKER=1
if "!MENU_CHOICE!"=="5" set BUILD_MODE=linux& set NEEDS_DOCKER=1
if "!MENU_CHOICE!"=="6" set BUILD_MODE=linux-dir& set NEEDS_DOCKER=1
if "!MENU_CHOICE!"=="7" set BUILD_MODE=all& set NEEDS_DOCKER=1

REM  Fail on a stopped engine now, before package.json is touched.
if "!NEEDS_DOCKER!"=="1" (
    call :preflight_docker
    if errorlevel 1 (
        pause
        exit /b 1
    )
)

REM --- Offer a version bump -----------------------------------------
REM  Needs Node for the semver arithmetic. A Linux-only build is
REM  otherwise possible on a host with no Node at all, so skip the
REM  whole step rather than demanding an install for it.
where node >nul 2>nul
if errorlevel 1 goto :apply_version

set CURRENT_VERSION=
for /f "usebackq delims=" %%v in (`node -p "require('./package.json').version"`) do set CURRENT_VERSION=%%v
if not defined CURRENT_VERSION goto :apply_version

set NEXT_PATCH=
set NEXT_MINOR=
set NEXT_MAJOR=
for /f "usebackq tokens=1,2,3" %%a in (`node -p "var p=require('./package.json').version.split('-')[0].split('.').map(Number); p[0]+'.'+p[1]+'.'+(p[2]+1)+' '+p[0]+'.'+(p[1]+1)+'.0 '+(p[0]+1)+'.0.0'"`) do (
    set NEXT_PATCH=%%a
    set NEXT_MINOR=%%b
    set NEXT_MAJOR=%%c
)
if not defined NEXT_PATCH goto :apply_version

echo   Bump the version before building?
echo.
echo   An installed copy only offers an update when the published
echo   version is higher than the one it runs, so a release needs a
echo   new number. Keep it for a test build.
echo.
echo     [1]  Keep !CURRENT_VERSION!                       ^(default^)
echo     [2]  Patch  -^>  !NEXT_PATCH!                  bug fixes
echo     [3]  Minor  -^>  !NEXT_MINOR!                  new features
echo     [4]  Major  -^>  !NEXT_MAJOR!                  breaking changes
echo     [5]  Type an exact version
echo.

choice /c 12345 /n /m "  Choose [1-5]: "
set VERSION_CHOICE=!errorlevel!
echo.

if "!VERSION_CHOICE!"=="1" goto :apply_version
if "!VERSION_CHOICE!"=="2" set VERSION_ARG=patch& goto :apply_version
if "!VERSION_CHOICE!"=="3" set VERSION_ARG=minor& goto :apply_version
if "!VERSION_CHOICE!"=="4" set VERSION_ARG=major& goto :apply_version

REM  Typed by hand, so it is checked here and re-asked until it is
REM  usable. Deliberately not inside an if(...) block: a literal ")"
REM  in a prompt string closes the block early and cmd then runs the
REM  fragments as commands.
:ask_exact_version
set VERSION_ARG=
set /p VERSION_ARG="  New version, e.g. 1.2.3  - blank keeps !CURRENT_VERSION!: "
echo.
if not defined VERSION_ARG goto :have_mode
call :validate_version_arg "!VERSION_ARG!"
if not errorlevel 1 goto :apply_version

echo   Not a valid version: !VERSION_ARG!
echo   Use three numbers, like 1.2.3.
echo.
goto :ask_exact_version

REM ===================================================================
REM  Apply the version bump, if one was requested
REM ===================================================================
:apply_version
if not defined VERSION_ARG goto :have_mode

where node >nul 2>nul
if errorlevel 1 (
    echo   [X] Node.js is required to change the version.
    echo.
    pause
    exit /b 1
)

REM  Validate before npm sees it. npm is not a usable gate here:
REM  `npm version not-a-version --allow-same-version` exits 0 and
REM  silently changes nothing, so a typo would sail through and
REM  produce a "release" still carrying the old number - an update
REM  that installs for nobody.
call :validate_version_arg "!VERSION_ARG!"
if errorlevel 1 (
    echo   [X] "!VERSION_ARG!" is not a version this script accepts.
    echo.
    echo   Use patch, minor, major, or a plain semver value like 1.2.3.
    echo.
    pause
    exit /b 1
)

set OLD_VERSION=
for /f "usebackq delims=" %%v in (`node -p "require('./package.json').version"`) do set OLD_VERSION=%%v

REM  --allow-same-version keeps "type the version you already have"
REM  from being treated as an error.
call npm version !VERSION_ARG! --no-git-tag-version --allow-same-version >nul 2>nul
if errorlevel 1 (
    echo   [X] npm could not set the version to "!VERSION_ARG!".
    echo.
    pause
    exit /b 1
)

set NEW_VERSION=
for /f "usebackq delims=" %%v in (`node -p "require('./package.json').version"`) do set NEW_VERSION=%%v

REM  Report what actually landed, not what was asked for.
if "!NEW_VERSION!"=="!OLD_VERSION!" echo   Version: !NEW_VERSION! - unchanged
if not "!NEW_VERSION!"=="!OLD_VERSION!" echo   Version: !OLD_VERSION! -^> !NEW_VERSION!  - package.json updated, git untouched
echo.

:have_mode

REM --- Work out what to build ---------------------------------------
set DO_WIN=0
set DO_LINUX=0
set HAS_APPIMAGE=0
set NPM_SCRIPT=
set EB_LINUX_ARGS=
set MODE_LABEL=

if /i "%BUILD_MODE%"=="installer" (
    set DO_WIN=1
    set NPM_SCRIPT=build
    set MODE_LABEL=Windows installer
) else if /i "%BUILD_MODE%"=="portable" (
    set DO_WIN=1
    set NPM_SCRIPT=build:portable
    set MODE_LABEL=Windows portable executable
) else if /i "%BUILD_MODE%"=="dir" (
    set DO_WIN=1
    set NPM_SCRIPT=build:dir
    set MODE_LABEL=Windows unpacked folder ^(no installer^)
) else if /i "%BUILD_MODE%"=="linux" (
    set DO_LINUX=1
    set HAS_APPIMAGE=1
    set EB_LINUX_ARGS=--linux --publish never
    set MODE_LABEL=Linux AppImage + deb + tar.gz
) else if /i "%BUILD_MODE%"=="linux-appimage" (
    set DO_LINUX=1
    set HAS_APPIMAGE=1
    set EB_LINUX_ARGS=--linux AppImage --publish never
    set MODE_LABEL=Linux AppImage
) else if /i "%BUILD_MODE%"=="linux-deb" (
    set DO_LINUX=1
    set EB_LINUX_ARGS=--linux deb --publish never
    set MODE_LABEL=Linux deb package
) else if /i "%BUILD_MODE%"=="linux-targz" (
    set DO_LINUX=1
    set EB_LINUX_ARGS=--linux tar.gz --publish never
    set MODE_LABEL=Linux tar.gz archive
) else if /i "%BUILD_MODE%"=="linux-dir" (
    set DO_LINUX=1
    set EB_LINUX_ARGS=--linux --dir --publish never
    set MODE_LABEL=Linux unpacked folder ^(no packages^)
) else if /i "%BUILD_MODE%"=="all" (
    set DO_WIN=1
    set DO_LINUX=1
    set HAS_APPIMAGE=1
    set NPM_SCRIPT=build
    set EB_LINUX_ARGS=--linux --publish never
    set MODE_LABEL=Windows installer + all Linux packages
) else (
    echo   [X] Unknown option: %BUILD_MODE%
    echo.
    echo   Valid options are:
    echo     installer ^| portable ^| dir
    echo     linux ^| linux-appimage ^| linux-deb ^| linux-targz ^| linux-dir
    echo     all
    echo.
    pause
    exit /b 1
)

REM --- Read the version out of package.json -------------------------
REM  Prefer node; fall back to plain text parsing so a Linux-only build
REM  does not require Node.js on the Windows host at all.
set APP_VERSION=
where node >nul 2>nul
if not errorlevel 1 (
    for /f "usebackq delims=" %%v in (`node -p "require('./package.json').version"`) do set APP_VERSION=%%v
)
if not defined APP_VERSION (
    for /f "tokens=2 delims=:, " %%v in ('findstr /r /c:"\"version\":" package.json') do (
        if not defined APP_VERSION set APP_VERSION=%%~v
    )
)

echo   Version : !APP_VERSION!
echo   Target  : !MODE_LABEL!
echo.

if "!DO_WIN!"=="1" goto :build_windows
goto :build_linux

REM ===================================================================
REM  Windows build - runs natively on this machine
REM ===================================================================
:build_windows

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

echo   Building for Windows. This usually takes 1-3 minutes...
echo.

call npm run !NPM_SCRIPT!

if errorlevel 1 (
    echo.
    echo   [X] Windows build failed. See the errors above.
    echo.
    echo   Common fixes:
    echo     - Close Streamify if it is currently running
    echo     - Run:  npm run rebuild
    echo.
    pause
    exit /b 1
)

if "!DO_LINUX!"=="1" (
    echo.
    goto :build_linux
)
goto :summary

REM ===================================================================
REM  Linux build - runs inside the electron-builder container
REM ===================================================================
:build_linux
if not "!DO_LINUX!"=="1" goto :summary

REM --- Check Docker is installed and the engine is up ---------------
REM  The menu already ran this before touching package.json; running it
REM  again is cheap and covers command-line runs that skipped the menu.
call :preflight_docker
if errorlevel 1 (
    pause
    exit /b 1
)

REM --- Assemble the command that runs inside the container -----------
REM  Built from parts and expanded with !delayed! expansion so cmd does
REM  not mistake the shell's > and || for its own redirection.
REM
REM  1. yt-dlp-exec's preinstall shells out to plain `python`; some
REM     images only provide `python3`.
REM  2. npm 11 blocks dependency install scripts unless approved. That
REM     would silently skip yt-dlp's binary download. The container is
REM     throwaway and package-lock.json is pinned, so allow them here
REM     rather than loosening the policy for everyone in package.json.
REM  3. `npm ci` wipes node_modules first, so the Docker volume can
REM     never end up holding a mix of Windows and Linux binaries.
REM  4. install-app-deps recompiles sqlite3 against Electron's ABI.
REM  5. yt-dlp-exec's postinstall only *logs* a failed download, so
REM     check the binary really landed instead of shipping a build
REM     whose Discord artwork search is dead on arrival.
set "LX_PYTHON=command -v python >/dev/null 2>&1 || ln -sf $(command -v python3) /usr/local/bin/python"
set "LX_INSTALL=npm ci --no-audit --no-fund --dangerously-allow-all-scripts"
set "LX_NATIVE=npx electron-builder install-app-deps"
set "LX_VERIFY=test -s node_modules/yt-dlp-exec/bin/yt-dlp || { echo 'ERROR: the yt-dlp binary was not downloaded'; exit 1; }"
set "LINUX_CMD=set -e; !LX_PYTHON!; !LX_INSTALL!; !LX_NATIVE!; !LX_VERIFY!; npx electron-builder !EB_LINUX_ARGS!"

echo   Building for Linux inside !STREAMIFY_BUILDER_IMAGE!
echo   The first run downloads the image and can take 10+ minutes.
echo.

docker run --rm ^
    -v "%CD%":/project ^
    -v streamify-linux-node-modules:/project/node_modules ^
    -v streamify-npm-cache:/root/.npm ^
    -v streamify-electron-cache:/root/.cache/electron ^
    -v streamify-electron-builder-cache:/root/.cache/electron-builder ^
    -w /project ^
    "!STREAMIFY_BUILDER_IMAGE!" ^
    /bin/bash -c "!LINUX_CMD!"

if errorlevel 1 (
    echo.
    echo   [X] Linux build failed. See the errors above.
    echo.
    echo   Common fixes:
    echo     - Make sure this drive is shared with Docker Desktop
    echo       ^(Settings ^> Resources ^> File sharing^)
    echo     - If package-lock.json is out of date, run `npm install`
    echo       on Windows first and commit the updated lock file
    echo     - Reset the container's dependencies:
    echo         docker volume rm streamify-linux-node-modules
    echo     - A yt-dlp binary fetch failure is usually a rate-limited
    echo       GitHub API; wait a few minutes and retry
    echo.
    pause
    exit /b 1
)

REM ===================================================================
REM  Summary
REM ===================================================================
:summary
echo.
echo   ============================================
echo    Build complete
echo   ============================================
echo.

if "!DO_WIN!"=="1" (
    if /i "%BUILD_MODE%"=="dir" (
        echo   Unpacked Windows app:
        echo     dist-electron\win-unpacked\Streamify.exe
    ) else if /i "%BUILD_MODE%"=="portable" (
        echo   Portable Windows app:
        echo     dist-electron\Streamify-Portable-!APP_VERSION!.exe
    ) else (
        echo   Windows installer ready to share:
        echo     dist-electron\Streamify-Setup-!APP_VERSION!.exe
    )
    echo.
    echo   Note: the build is unsigned, so Windows SmartScreen will warn
    echo   on first run. Click "More info" then "Run anyway".
    echo.
)

if "!DO_LINUX!"=="1" (
    if /i "%BUILD_MODE%"=="linux-dir" (
        echo   Unpacked Linux app:
        echo     dist-electron\linux-unpacked\streamify
        echo.
    ) else (
        call :list_linux_artifacts
    )
)

if "!HAS_APPIMAGE!"=="1" (
    echo   Note: after copying the .AppImage to a Linux machine, make it
    echo   executable with:  chmod +x Streamify-*.AppImage
    echo.
)

REM --- Offer to open the output folder ------------------------------
choice /c YN /n /m "  Open the output folder? [Y/N] "
if errorlevel 2 goto :done
if errorlevel 1 start "" explorer "%~dp0dist-electron"

:done
echo.
endlocal
exit /b 0

REM ===================================================================
REM  Subroutines
REM ===================================================================

REM  Accepts patch, minor, major, or a plain semver value with an
REM  optional pre-release or build suffix.
REM
REM  The value reaches node through an environment variable rather than
REM  argv so that cmd never has to quote a regex, and the regex avoids
REM  \d and \w so no backslash survives batch parsing.
REM  Returns 0 when the value is usable, 1 otherwise.
:validate_version_arg
set "SV=%~1"
if /i "%SV%"=="patch" exit /b 0
if /i "%SV%"=="minor" exit /b 0
if /i "%SV%"=="major" exit /b 0
node -e "var v=(process.env.SV||'').replace(/^v/,'');process.exit(/^[0-9]+[.][0-9]+[.][0-9]+([-+][0-9A-Za-z.-]+)?$/.test(v)?0:1)"
exit /b %errorlevel%

REM  Docker must be present AND its engine reachable. Installing Docker
REM  Desktop does not start it, so the two failures need separate
REM  messages - "not found" sends someone to the download page they
REM  have already visited.
REM  Returns 0 when a Linux build can proceed, 1 otherwise.
:preflight_docker
where docker >nul 2>nul
if errorlevel 1 (
    echo   [X] Docker was not found, so the Linux packages cannot be built.
    echo.
    echo   Linux targets need dpkg/appimagetool and a Linux-compiled
    echo   sqlite3, none of which exist on Windows.
    echo.
    echo   Install Docker Desktop from https://docker.com/products/docker-desktop
    echo   then run this file again.
    echo.
    echo   Alternatively, run this on a Linux machine:
    echo       npm ci ^&^& npm run build:linux
    echo.
    exit /b 1
)

docker info >nul 2>nul
if errorlevel 1 (
    echo   [X] Docker is installed but the engine is not responding.
    echo.
    echo   Open Docker Desktop and wait until it reports "Engine running",
    echo   then run this file again. A fresh install does not start the
    echo   engine on its own.
    echo.
    exit /b 1
)
exit /b 0

REM  List whatever the Linux build actually produced, rather than
REM  guessing filenames - electron-builder renames the arch per target
REM  (x86_64 for AppImage, amd64 for deb, x64 for tar.gz).
:list_linux_artifacts
echo   Linux packages:
set ARTIFACT_FOUND=0
for %%f in ("dist-electron\*.AppImage" "dist-electron\*.deb" "dist-electron\*.tar.gz") do (
    set ARTIFACT_FOUND=1
    echo     dist-electron\%%~nxf
)
if "!ARTIFACT_FOUND!"=="0" echo     ^(nothing found - check the dist-electron folder^)
echo.
goto :eof
