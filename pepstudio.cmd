@echo off
rem PepStudio - Windows launcher.
rem
rem Why this file exists: PowerShell's default execution policy (Restricted) blocks every .ps1
rem on the machine, and npm ships its shim AS npm.ps1 - so `npm run electron` dies with
rem "running scripts is disabled on this system" before npm is even reached. A .cmd file is not
rem a PowerShell script, so it runs under that same policy untouched: no Set-ExecutionPolicy,
rem no admin rights, nothing changed system-wide.
rem
rem Double-click it, or run  .\pepstudio.cmd  (add --booth to open just the recorder).
rem It cd-s to its own folder first, so it works from any prompt and from Explorer.
setlocal
cd /d "%~dp0"

where node 1>nul 2>nul
if errorlevel 1 (
  echo PepStudio: Node.js is not on PATH. Install it from https://nodejs.org, then reopen this window.
  pause
  exit /b 1
)

if not exist "node_modules\electron" (
  echo PepStudio: installing dependencies, one time...
  call npm.cmd install --no-audit --no-fund
  if errorlevel 1 (
    echo PepStudio: npm install failed - see the errors above.
    pause
    exit /b 1
  )
)

echo PepStudio: starting...
call "node_modules\.bin\electron.cmd" . %*
if errorlevel 1 pause
endlocal
